#!/bin/bash
set -euo pipefail
#
# Generic, profile-driven game-server start. This script is GAME-AGNOSTIC: every
# game-specific value (image, env-var names, volumes, ports) comes from the
# emitted game-profile.json (the runtime subset of the active GameProfile,
# lib/games/index.ts:runtimeProfile). The active world (name/password/world save)
# comes from SSM, written by the /gate start Lambda. Together they produce the
# exact `docker run` validated locally by docker-compose.local.yml.
#
# Inputs:
#   /etc/gatekeeper/game-profile.json   - the runtime profile (emitted by CDK)
#   SSM /gatekeeper/<game-id>/active-world - JSON {name, worldName, serverPassword, extraArgs?, adminIds?}

PROFILE=/etc/gatekeeper/game-profile.json

echo "$(date '+%Y-%m-%d %H:%M:%S') - Starting game server"

REGION=$(curl -s --connect-timeout 5 http://169.254.169.254/latest/meta-data/placement/region)
if [ -z "$REGION" ]; then
  echo "ERROR: Could not determine AWS region from instance metadata"
  exit 1
fi

if [ ! -f "$PROFILE" ]; then
  echo "ERROR: game profile not found at $PROFILE"
  exit 1
fi

if ! docker info > /dev/null 2>&1; then
  echo "ERROR: Docker service is not running or not accessible"
  exit 1
fi

# --- Read the game profile -------------------------------------------------
GAME_ID=$(jq -r '.id' "$PROFILE")
IMAGE=$(jq -r '.image' "$PROFILE")
NAME=$(jq -r '.containerName' "$PROFILE")
QUERY_PORT=$(jq -r '.queryPort' "$PROFILE")
DEFAULT_ARGS=$(jq -r '.defaultArgs // ""' "$PROFILE")

echo "Game: $GAME_ID  Image: $IMAGE  Container: $NAME"

# Already running? Idempotent — do nothing.
if docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
  echo "$NAME is already running"
  exit 0
fi
# Clean up any stopped container of the same name.
docker rm "$NAME" > /dev/null 2>&1 || true

# --- Resolve the active world from SSM -------------------------------------
WORLD_NAME=""; SERVER_NAME=""; SERVER_PASSWORD=""; EXTRA_ARGS=""; ADMIN_IDS=""
ACTIVE_WORLD_PARAM="/gatekeeper/${GAME_ID}/active-world"
if WORLD_JSON=$(aws ssm get-parameter --name "$ACTIVE_WORLD_PARAM" --region "$REGION" --query "Parameter.Value" --output text 2>/dev/null); then
  if echo "$WORLD_JSON" | jq . > /dev/null 2>&1; then
    WORLD_NAME=$(echo "$WORLD_JSON" | jq -r '.worldName // empty')
    SERVER_NAME=$(echo "$WORLD_JSON" | jq -r '.name // empty')
    SERVER_PASSWORD=$(echo "$WORLD_JSON" | jq -r '.serverPassword // empty')
    EXTRA_ARGS=$(echo "$WORLD_JSON" | jq -r '.extraArgs // empty')
    ADMIN_IDS=$(echo "$WORLD_JSON" | jq -r '.adminIds // empty')
    echo "Active world: ${SERVER_NAME:-?} (${WORLD_NAME:-default})"
  else
    echo "WARNING: active-world parameter is not valid JSON; booting image defaults"
  fi
else
  echo "NOTICE: no active-world parameter; booting image defaults"
fi

# --- Build docker args from the profile ------------------------------------
ENV_ARGS=(); PORT_ARGS=(); VOL_ARGS=()

# Static env: always-on container settings (e.g. AutoUpdate=true).
while IFS=$'\t' read -r k v; do
  [ -n "$k" ] && ENV_ARGS+=( -e "${k}=${v}" )
done < <(jq -r '.staticEnv // {} | to_entries[] | [.key, .value] | @tsv' "$PROFILE")

# Mapped env: canonical config field -> this game's container env-var name.
add_env() { # $1 = container var name (from envMap), $2 = value
  local var="$1" val="$2"
  if [ -n "$var" ] && [ "$var" != "null" ] && [ -n "$val" ] && [ "$val" != "null" ]; then
    ENV_ARGS+=( -e "${var}=${val}" )
  fi
}
add_env "$(jq -r '.envMap.serverName // empty' "$PROFILE")" "$SERVER_NAME"
add_env "$(jq -r '.envMap.password // empty'   "$PROFILE")" "$SERVER_PASSWORD"
add_env "$(jq -r '.envMap.worldName // empty'  "$PROFILE")" "$WORLD_NAME"
add_env "$(jq -r '.envMap.adminIds // empty'   "$PROFILE")" "$ADMIN_IDS"
# Launch args: always-applied defaultArgs combined with this world's extraArgs.
ALL_ARGS=$(echo "${DEFAULT_ARGS} ${EXTRA_ARGS}" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
add_env "$(jq -r '.envMap.extraArgs // empty' "$PROFILE")" "$ALL_ARGS"

# Ports: each profile port range, plus the Steam A2S query port.
while IFS=$'\t' read -r proto from to; do
  if [ "$from" = "$to" ]; then
    PORT_ARGS+=( -p "${from}:${from}/${proto}" )
  else
    PORT_ARGS+=( -p "${from}-${to}:${from}-${to}/${proto}" )
  fi
done < <(jq -r '.ports[] | [.protocol, .from, .to] | @tsv' "$PROFILE")
PORT_ARGS+=( -p "${QUERY_PORT}:${QUERY_PORT}/udp" )

# Volumes: persistent data bind mounts (host dirs live on the RETAIN'd EBS).
while IFS=$'\t' read -r host cont; do
  mkdir -p "$host"
  VOL_ARGS+=( -v "${host}:${cont}" )
done < <(jq -r '.volumes[] | [.hostPath, .containerPath] | @tsv' "$PROFILE")

# --- Launch ----------------------------------------------------------------
# --restart unless-stopped covers the transient first-boot SteamCMD
# "Missing configuration" exit (validated locally: a re-run pulls cleanly).
echo "Launching $NAME..."
if ! CONTAINER_ID=$(docker run -d --name "$NAME" --restart unless-stopped \
  "${PORT_ARGS[@]}" "${VOL_ARGS[@]}" "${ENV_ARGS[@]}" "$IMAGE"); then
  echo "ERROR: Failed to start container"
  exit 1
fi
echo "Container started: $CONTAINER_ID"

# First boot under Wine + SteamCMD is slow; the readiness/auto-shutdown signal
# is handled separately by A2S monitoring. Here we just confirm it didn't crash.
sleep 5
if docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') - $NAME running (world: ${WORLD_NAME:-default})"
  exit 0
fi
echo "ERROR: container exited immediately. Logs:"
docker logs "$NAME" 2>&1 | tail -50 || true
exit 1
