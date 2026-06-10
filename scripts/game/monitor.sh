#!/bin/bash
#
# Game-agnostic server monitor (on-host). Queries Steam A2S at 127.0.0.1:<queryPort>
# every cycle to get liveness + player count, then:
#   - writes the player count to SSM + CloudWatch,
#   - posts a readiness message to Discord on the first down->up transition,
#   - stops the instance (after a backup) once idle for longer than the
#     SSM-configured auto-shutdown window.
#
# Querying localhost means the A2S query port (27015) never has to be exposed to
# the internet — only the game port is public. Everything game-specific is read
# from /etc/gatekeeper/game-profile.json; the active world (for the Discord
# webhook + world name) comes from SSM, written by /gate start.

PROFILE=/etc/gatekeeper/game-profile.json
CONF=/etc/gatekeeper.conf
A2S=/usr/local/bin/a2s-query.js
# GAME_DOMAIN (the derived <subdomain>.<BASE_DOMAIN>) comes from here when set.
[ -f "$CONF" ] && source "$CONF"
ACTIVITY_FILE=/tmp/gk_last_activity
SEEN_LIVE_FLAG=/tmp/gk_seen_live   # set once the server first answers A2S this session
LIVE_STATE_FILE=/tmp/gk_live       # "1" while last cycle was live (edge detection)

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') - $1"; }

# IMDSv2-aware metadata fetch. AL2023 enforces HttpTokens=required, so bare
# IMDSv1 curls 401; fetch a token first (still works where IMDSv1 is optional).
imds() {
  local t
  t=$(curl -s -m 5 -X PUT http://169.254.169.254/latest/api/token \
        -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
  curl -s -m 5 -H "X-aws-ec2-metadata-token: $t" \
        "http://169.254.169.254/latest/meta-data/$1"
}

REGION=$(imds placement/region)
INSTANCE_ID=$(imds instance-id)
[ -z "$REGION" ] && { log "ERROR: no region from metadata"; exit 1; }

GAME_ID=$(jq -r '.id' "$PROFILE")
QUERY_PORT=$(jq -r '.queryPort' "$PROFILE")
GAME_PORT=$(jq -r '.ports[0].from' "$PROFILE")
CONTAINER_NAME=$(jq -r '.containerName' "$PROFILE")
JOIN_CODE_PATTERN=$(jq -r '.joinCodePattern // empty' "$PROFILE")
# A2S fallback (e.g. Valheim -crossplay goes A2S-silent): an ERE whose latest
# log match carries the player count as its last number; a match within the
# last 5 minutes also counts as liveness.
PLAYERS_LOG_PATTERN=$(jq -r '.playersLogPattern // empty' "$PROFILE")
# Join port + hint for the readiness embed (mirrors /gate join + status). Port
# falls back to the first game port; hint is the game's connect instructions.
JOIN_PORT=$(jq -r '.join.port // .ports[0].from' "$PROFILE")
JOIN_HINT=$(jq -r '.join.hint // empty' "$PROFILE")
CODE_LABEL=$(jq -r '.join.codeLabel // "Join Code"' "$PROFILE")
ADDRESS_WITH_PORT=$(jq -r '.join.addressWithPort // false' "$PROFILE")
NAMESPACE="GameServer"
PLAYER_COUNT_PARAM="/gatekeeper/${GAME_ID}/player-count"
AUTO_SHUTDOWN_PARAM="/gatekeeper/${GAME_ID}/auto-shutdown-minutes"
BOOT_TIMEOUT_PARAM="/gatekeeper/${GAME_ID}/boot-timeout-minutes"
ACTIVE_WORLD_PARAM="/gatekeeper/${GAME_ID}/active-world"
JOIN_CODE_PARAM="/gatekeeper/${GAME_ID}/join-code"

# Fresh session: clear edge/idle state so stale files can't trigger an instant shutdown.
rm -f "$SEEN_LIVE_FLAG" "$LIVE_STATE_FILE"
date +%s > "$ACTIVITY_FILE"
BOOT_START=$(date +%s) # for the boot-timeout safety net (server-never-comes-up guard)
log "Monitoring $GAME_ID (A2S 127.0.0.1:$QUERY_PORT, game port $GAME_PORT)"

# Resolve the Discord webhook for the active world (best-effort; may be unset).
get_webhook_url() {
  local wj guild
  wj=$(aws ssm get-parameter --name "$ACTIVE_WORLD_PARAM" --region "$REGION" --query "Parameter.Value" --output text 2>/dev/null) || return 1
  guild=$(echo "$wj" | jq -r '.discordServerId // empty') || return 1
  [ -z "$guild" ] && return 1
  aws ssm get-parameter --name "/gatekeeper/${GAME_ID}/discord-webhook/${guild}" --with-decryption \
    --region "$REGION" --query "Parameter.Value" --output text 2>/dev/null
}

# Persona for webhook posts — the message-level username/avatar IS the character
# (e.g. Dr. Derek Manse), so the embed itself stays clean: no author byline
# repeating the same name/face, footer from the profile (game-agnostic).
PERSONA_NAME=$(jq -r '.persona.characterName // "GATEKeeper"' "$PROFILE")
PERSONA_AVATAR=$(jq -r '.persona.thumbnailUrl // empty' "$PROFILE")
PERSONA_FOOTER=$(jq -r '.persona.footer // empty' "$PROFILE")

post_discord() { # $1 = title, $2 = description, $3 = color (decimal), $4 = optional JSON embed-fields array
  local url; url=$(get_webhook_url) || { log "no webhook configured; skipping Discord post"; return 0; }
  [ -z "$url" ] || [ "$url" = "None" ] && { log "no webhook configured; skipping Discord post"; return 0; }
  # Build the payload with jq so the name/avatar/text are safely JSON-escaped.
  local payload
  payload=$(jq -n --arg name "$PERSONA_NAME" --arg avatar "$PERSONA_AVATAR" --arg footer "$PERSONA_FOOTER" \
    --arg title "$1" --arg desc "$2" --argjson color "$3" --argjson fields "${4:-[]}" \
    '{username: $name, embeds: [{title: $title, description: $desc, color: $color}]}
     | if $footer != "" then .embeds[0].footer = {text: $footer} else . end
     | if ($fields | length) > 0 then .embeds[0].fields = $fields else . end
     | if $avatar != "" then .avatar_url = $avatar else . end')
  curl -s -m 10 -H "Content-Type: application/json" -X POST "$url" -d "$payload" \
    > /dev/null 2>&1 || log "WARNING: Discord post failed"
}

while true; do
  NOW=$(date +%s)

  # --- A2S query (liveness + player count) ---
  # Query the container's bridge IP directly: Docker's published-UDP-port
  # forwarding is unreliable over loopback (docker-proxy/conntrack mangles the
  # reply path), so 127.0.0.1:<port> can stay dead while the server is fully
  # live externally. Host -> container-IP has no proxy in the path. Resolved
  # every cycle since the IP can change when the container restarts.
  TARGET_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' \
    "$CONTAINER_NAME" 2>/dev/null)
  [ -z "$TARGET_IP" ] && TARGET_IP=127.0.0.1
  PLAYERS=0; LIVE=false
  if OUT=$(node "$A2S" "$TARGET_IP" "$QUERY_PORT" 4000 2>/dev/null); then
    LIVE=true
    PLAYERS=$(echo "$OUT" | sed 's/^LIVE //' | jq -r '.players // 0' 2>/dev/null)
    [[ "$PLAYERS" =~ ^[0-9]+$ ]] || PLAYERS=0
  elif [ -n "$PLAYERS_LOG_PATTERN" ]; then
    # A2S silent — fall back to the game's log heartbeat (last 5 minutes).
    MATCH=$(docker logs --since 5m "$CONTAINER_NAME" 2>&1 | grep -oE "$PLAYERS_LOG_PATTERN" | tail -1)
    if [ -n "$MATCH" ]; then
      LIVE=true
      PLAYERS=$(echo "$MATCH" | grep -oE '[0-9]+' | tail -1)
      [[ "$PLAYERS" =~ ^[0-9]+$ ]] || PLAYERS=0
    fi
  fi

  # --- Readiness: first transition to live this session ---
  WAS_LIVE=$( [ -f "$LIVE_STATE_FILE" ] && echo 1 || echo 0 )
  if [ "$LIVE" = true ]; then
    echo 1 > "$LIVE_STATE_FILE"
    if [ ! -f "$SEEN_LIVE_FLAG" ]; then
      touch "$SEEN_LIVE_FLAG"
      # Prefer the stable derived domain; fall back to the public IP.
      JOIN_HOST="${GAME_DOMAIN:-}"
      [ -z "$JOIN_HOST" ] && JOIN_HOST=$(imds public-ipv4)
      # Per-session lobby/join code: scrape the container logs (pattern from the
      # profile; the code is the last token of the latest match) and publish to
      # SSM so /gate join can show it. 'none' = scrape found nothing.
      JOIN_CODE=""
      if [ -n "$JOIN_CODE_PATTERN" ]; then
        JOIN_CODE=$(docker logs "$CONTAINER_NAME" 2>&1 | grep -oE "$JOIN_CODE_PATTERN" | tail -1 | awk '{print $NF}')
        aws ssm put-parameter --name "$JOIN_CODE_PARAM" --type String \
          --value "${JOIN_CODE:-none}" --overwrite --region "$REGION" > /dev/null 2>&1
        log "Session join code: ${JOIN_CODE:-not found}"
      fi
      log "Server is LIVE (first time this session) at ${JOIN_HOST}:${JOIN_PORT}"
      # The active world's password (players need it for Direct Connect).
      SERVER_PASSWORD=$(aws ssm get-parameter --name "$ACTIVE_WORLD_PARAM" --region "$REGION" \
        --query "Parameter.Value" --output text 2>/dev/null | jq -r '.serverPassword // empty' 2>/dev/null)
      # Build the SAME copyable join fields /gate join + /gate status render
      # (util/join-info): Address full-width, then Port / Password (spoiler-
      # wrapped) / Lobby Code inline. Password & code included only when present.
      # Fenced blocks (```…```) get Discord's native Copy button; password is
      # spoiler-wrapped (||…||). Built with jq string interpolation rather than
      # `+` concat — jq 1.7 mis-parses concatenating a backtick string.
      JOIN_FIELDS=$(jq -n --arg host "$JOIN_HOST" --arg port "$JOIN_PORT" \
        --arg pw "$SERVER_PASSWORD" --arg code "$JOIN_CODE" --arg codeLabel "$CODE_LABEL" \
        --argjson awp "$ADDRESS_WITH_PORT" '
        [ {name: "🌐 Address", value: "```\n\(if $awp then "\($host):\($port)" else $host end)\n```", inline: false} ]
        + (if $awp then [] else [{name: "🔌 Port", value: "```\n\($port)\n```", inline: true}] end)
        + (if $pw   != "" then [{name: "🔑 Password",   value: "||```\n\($pw)\n```||", inline: true}] else [] end)
        + (if $code != "" then [{name: "🎟️ \($codeLabel)", value: "```\n\($code)\n```", inline: true}] else [] end)')
      DESC="${JOIN_HINT:-The server is live — connect with the details below.}"
      post_discord "🟢 Server Online" "$DESC" 3776160 "$JOIN_FIELDS"
    fi
  else
    rm -f "$LIVE_STATE_FILE"
  fi

  # --- Player count -> SSM + CloudWatch ---
  log "Players: $PLAYERS (live=$LIVE)"
  aws ssm put-parameter --name "$PLAYER_COUNT_PARAM" --type String --value "$PLAYERS" --overwrite --region "$REGION" > /dev/null 2>&1
  aws cloudwatch put-metric-data --namespace "$NAMESPACE" --metric-name PlayerCount \
    --value "$PLAYERS" --unit Count --region "$REGION" > /dev/null 2>&1

  # --- Boot-timeout safety net: if the server NEVER answers A2S (e.g. a wedged
  #     first boot / SteamCMD failure loop), stop the box so it can't bill forever.
  #     Only applies before first liveness; the idle path below takes over after. ---
  if [ ! -f "$SEEN_LIVE_FLAG" ]; then
    BOOT_TIMEOUT=$(aws ssm get-parameter --name "$BOOT_TIMEOUT_PARAM" --region "$REGION" --query 'Parameter.Value' --output text 2>/dev/null || echo "45")
    if [ "$BOOT_TIMEOUT" != "off" ] && [ "$BOOT_TIMEOUT" != "disabled" ]; then
      BOOTED=$((NOW - BOOT_START))
      log "Awaiting first liveness: ${BOOTED}s elapsed (boot-timeout ${BOOT_TIMEOUT}m)"
      if [ "$BOOTED" -gt $((BOOT_TIMEOUT * 60)) ]; then
        log "Server never came online after ${BOOT_TIMEOUT}m — stopping (likely a failed boot)"
        post_discord "⚠️ Server Failed to Start" "The server didn't come online within ${BOOT_TIMEOUT} minutes. Stopping to avoid charges — try \`/gate start\` again (the next boot is faster, the download is cached)." 15158332
        aws ec2 stop-instances --instance-ids "$INSTANCE_ID" --region "$REGION"
        break
      fi
    fi
  fi

  # --- Idle tracking / auto-shutdown (only after the server has been live once,
  #     so a slow first boot under Wine+SteamCMD is never mistaken for idle) ---
  AUTO_SHUTDOWN=$(aws ssm get-parameter --name "$AUTO_SHUTDOWN_PARAM" --region "$REGION" --query 'Parameter.Value' --output text 2>/dev/null || echo "20")
  if [ "$PLAYERS" -gt 0 ]; then
    echo "$NOW" > "$ACTIVITY_FILE"
  elif [ -f "$SEEN_LIVE_FLAG" ] && [ "$AUTO_SHUTDOWN" != "off" ] && [ "$AUTO_SHUTDOWN" != "disabled" ]; then
    THRESHOLD=$((AUTO_SHUTDOWN * 60))
    LAST=$(cat "$ACTIVITY_FILE" 2>/dev/null || echo "$NOW")
    IDLE=$((NOW - LAST))
    log "Idle for ${IDLE}s (threshold ${THRESHOLD}s)"
    if [ "$IDLE" -gt "$THRESHOLD" ]; then
      log "Idle threshold exceeded — backing up and shutting down"
      post_discord "💤 Server Idle" "No players for ${AUTO_SHUTDOWN} min. Backing up and shutting down." 16763904
      /usr/local/bin/backup-server.sh || log "WARNING: backup failed; stopping anyway (data persists on EBS)"
      aws ec2 stop-instances --instance-ids "$INSTANCE_ID" --region "$REGION"
      break
    fi
  fi

  sleep 120
done
