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

# IMDSv2-aware metadata fetch (AL2023 enforces token auth; works on optional too).
imds() {
  local t
  t=$(curl -s -m 5 -X PUT http://169.254.169.254/latest/api/token \
        -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
  curl -s -m 5 -H "X-aws-ec2-metadata-token: $t" \
        "http://169.254.169.254/latest/meta-data/$1"
}

REGION=$(imds placement/region)
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

# The data volume MUST be mounted before we host anything. A boot without it
# silently serves an empty world from the root disk (2026-08-21: the volume was
# detached by a deploy and never re-attached). Wait up to 2 minutes for the
# device — the deploy-time attach verifier may still be attaching it — then
# refuse to start rather than run without the worlds.
for _ in $(seq 1 24); do
  mountpoint -q /mnt/game-data && break
  [ -e /dev/nvme1n1 ] && mount -a 2>/dev/null || true
  sleep 5
done
if ! mountpoint -q /mnt/game-data; then
  echo "ERROR: /mnt/game-data is not mounted (data volume not attached?) — refusing to start"
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

# --- Sync the world's mods from the S3 library ------------------------------
# Game-agnostic: each library mod (s3://<bucket>/mods/<Name>/) declares its
# install `kind` in metadata.json; the profile maps kind -> host targetPath
# (+ optional container env, e.g. Valheim's BEPINEX=true). A manifest records
# every file installed so the next start removes exactly those files — never
# base-game files sharing the directory (AF paks land next to base pakchunks).
MOD_ENV_ARGS=()
MANIFEST=/mnt/game-data/.gatekeeper/mods.manifest
mkdir -p "$(dirname "$MANIFEST")"

if [ -f "$MANIFEST" ]; then
  while IFS= read -r f; do
    [ -n "$f" ] && rm -f "$f"
  done < "$MANIFEST"
  : > "$MANIFEST"
fi

MODS_JSON=$(echo "${WORLD_JSON:-}" | jq -c '.mods // []' 2>/dev/null || echo '[]')
HAS_KINDS=$(jq -r '.modKinds // {} | length' "$PROFILE")
if [ "$MODS_JSON" != "[]" ]; then
  GATEKEEPER_BUCKET=""
  [ -f /etc/gatekeeper.conf ] && source /etc/gatekeeper.conf
  if [ -z "$GATEKEEPER_BUCKET" ]; then
    echo "WARNING: world requests mods but GATEKEEPER_BUCKET is unset; skipping mods"
  elif [ "$HAS_KINDS" = "0" ]; then
    echo "WARNING: world requests mods but this game declares no mod kinds; skipping mods"
  else
    USED_KINDS=""
    for MOD in $(echo "$MODS_JSON" | jq -r '.[]'); do
      # Library names are CLI-enforced; refuse anything path- or shell-unsafe.
      if ! echo "$MOD" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]*$'; then
        echo "  WARNING: invalid mod name '$MOD'; skipping"; continue
      fi
      if ! META=$(aws s3 cp "s3://${GATEKEEPER_BUCKET}/mods/${MOD}/metadata.json" - 2>/dev/null); then
        echo "  WARNING: mod '$MOD' not found in the library; skipping"; continue
      fi
      KIND=$(echo "$META" | jq -r '.kind // empty')
      TARGET=$(jq -r --arg k "$KIND" '.modKinds[$k].targetPath // empty' "$PROFILE")
      if [ -z "$TARGET" ]; then
        echo "  WARNING: mod '$MOD' kind '${KIND:-?}' unsupported by this game; skipping"; continue
      fi
      COUNT=0
      while IFS= read -r KEY; do
        [ -z "$KEY" ] || [ "$KEY" = "None" ] && continue
        REL="${KEY#mods/${MOD}/files/}"
        DEST="${TARGET}/${REL}"
        mkdir -p "$(dirname "$DEST")"
        if aws s3 cp "s3://${GATEKEEPER_BUCKET}/${KEY}" "$DEST" --only-show-errors --region "$REGION"; then
          echo "$DEST" >> "$MANIFEST"
          COUNT=$((COUNT + 1))
        fi
      done < <(aws s3api list-objects-v2 --bucket "$GATEKEEPER_BUCKET" --prefix "mods/${MOD}/files/" \
                 --query 'Contents[].Key' --output text --region "$REGION" 2>/dev/null | tr '\t' '\n')
      echo "  Installed mod ${MOD} (${KIND}): ${COUNT} file(s) -> ${TARGET}"
      case " $USED_KINDS " in *" $KIND "*) ;; *) USED_KINDS="$USED_KINDS $KIND" ;; esac
    done
    # Kind env (e.g. BEPINEX=true) for every kind with at least one mod installed.
    for KIND in $USED_KINDS; do
      while IFS=$'\t' read -r k v; do
        [ -n "$k" ] && MOD_ENV_ARGS+=( -e "${k}=${v}" )
      done < <(jq -r --arg kind "$KIND" '.modKinds[$kind].env // {} | to_entries[] | [.key, .value] | @tsv' "$PROFILE")
    done
  fi
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

# Ports: each profile port range, plus the Steam A2S query port — unless a UDP
# range already covers it (Valheim: query 2457 sits inside 2456-2458; publishing
# the same port twice fails `docker run` with "port is already allocated").
QUERY_COVERED=0
while IFS=$'\t' read -r proto from to; do
  if [ "$from" = "$to" ]; then
    PORT_ARGS+=( -p "${from}:${from}/${proto}" )
  else
    PORT_ARGS+=( -p "${from}-${to}:${from}-${to}/${proto}" )
  fi
  if [ "$proto" = "udp" ] && [ "$from" -le "$QUERY_PORT" ] && [ "$QUERY_PORT" -le "$to" ]; then
    QUERY_COVERED=1
  fi
done < <(jq -r '.ports[] | [.protocol, .from, .to] | @tsv' "$PROFILE")
if [ "$QUERY_COVERED" = "0" ]; then
  PORT_ARGS+=( -p "${QUERY_PORT}:${QUERY_PORT}/udp" )
fi

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
  "${PORT_ARGS[@]}" "${VOL_ARGS[@]}" "${ENV_ARGS[@]}" "${MOD_ENV_ARGS[@]}" "$IMAGE"); then
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
