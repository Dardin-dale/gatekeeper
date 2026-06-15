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
# The game's slash command (gate/munin) for webhook copy — `/gate`, `/munin`.
SLASH_CMD="/$(jq -r '.commandName // "gate"' "$PROFILE")"
QUERY_PORT=$(jq -r '.queryPort' "$PROFILE")
GAME_PORT=$(jq -r '.ports[0].from' "$PROFILE")
CONTAINER_NAME=$(jq -r '.containerName' "$PROFILE")
JOIN_CODE_PATTERN=$(jq -r '.joinCodePattern // empty' "$PROFILE")
# A2S fallback (e.g. Valheim -crossplay goes A2S-silent). Two distinct EREs,
# matched against the FULL container log (not a time window):
#   PLAYERS_LOG_PATTERN  - the latest match's last number = current player count;
#                          point it at join/LEAVE event lines ("... now N player(s)")
#                          so the latest one reflects the live count.
#   LIVENESS_LOG_PATTERN - any match = server is up/joinable; point it at a
#                          heartbeat present even at 0 players ("... is active with
#                          N player(s)"). Separate because the count must not come
#                          from a heartbeat that can report a stale 0 under crossplay.
PLAYERS_LOG_PATTERN=$(jq -r '.playersLogPattern // empty' "$PROFILE")
LIVENESS_LOG_PATTERN=$(jq -r '.livenessLogPattern // empty' "$PROFILE")
# Event-bookkeeping count (e.g. Abiotic Factor over EOS): when both are set the
# count is net presence = (#join matches − #leave matches) over the full log,
# OVERRIDING the A2S count (A2S answers for AF but is EOS-blind, always 0).
PLAYER_JOIN_PATTERN=$(jq -r '.playerJoinPattern // empty' "$PROFILE")
PLAYER_LEAVE_PATTERN=$(jq -r '.playerLeavePattern // empty' "$PROFILE")
# Flavor events to announce to Discord (deaths, raids, joins…): a JSON array of
# {id,pattern,title,body?,nameSed?,color?}. Scraped each cycle, deduped, gated by
# the `events` notify toggle. See scan_events() + GameProfile.events.
EVENTS_JSON=$(jq -c '.events // []' "$PROFILE")
EVENT_COUNT=$(echo "$EVENTS_JSON" | jq 'length')
# Log window scanned for events each cycle. Larger than the slow cadence (120s)
# so nothing is missed between cycles; dedup makes the overlap a no-op.
EVENT_WINDOW="300s"
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
SERVER_LIVE_PARAM="/gatekeeper/${GAME_ID}/server-live"

put_param() { # $1 = name, $2 = value (best-effort)
  aws ssm put-parameter --name "$1" --type String --value "$2" --overwrite \
    --region "$REGION" > /dev/null 2>&1
}
# Invalidate the previous session in SSM: the join code is per-session, so until
# this run's scrape lands, /gate join|status must see 'none' — not last run's
# dead code. server-live=false tells the lambdas the game isn't joinable yet.
invalidate_session_params() {
  put_param "$JOIN_CODE_PARAM" "none"
  put_param "$SERVER_LIVE_PARAM" "false"
}

# Fresh session: clear edge/idle state so stale files can't trigger an instant shutdown.
rm -f "$SEEN_LIVE_FLAG" "$LIVE_STATE_FILE"
date +%s > "$ACTIVITY_FILE"
invalidate_session_params
MISS_COUNT=0          # consecutive failed liveness checks (for down-debounce)
LAST_PLAYERS=0        # last good player count (held through a debounced blip)
PUBLISHED_JOIN_CODE="" # join code currently in SSM (rewrite only on change)
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
# Character art -> embed thumbnail ("the full image in the rich text"); bot app
# icon -> webhook avatar (so posts read as the bot). Icon falls back to the art.
PERSONA_THUMB=$(jq -r '.persona.thumbnailUrl // empty' "$PROFILE")
PERSONA_ICON=$(jq -r '.persona.iconUrl // .persona.thumbnailUrl // empty' "$PROFILE")
PERSONA_FOOTER=$(jq -r '.persona.footer // empty' "$PROFILE")
PERSONA_COLOR=$(jq -r '.persona.color // 3776160' "$PROFILE") # default event embed color

# Whether a notification category is enabled. Toggled per-game via `/<cmd> notify`
# (SSM /gatekeeper/<game>/notify/<category>); ENABLED by default when unset. Guard
# each post with `notify_enabled <category> && post_discord ...` so silencing a
# category suppresses only its Discord message, never the underlying action.
notify_enabled() { # $1 = category
  local v
  v=$(aws ssm get-parameter --name "/gatekeeper/${GAME_ID}/notify/$1" \
        --region "$REGION" --query 'Parameter.Value' --output text 2>/dev/null || true)
  [ "$v" != "off" ]
}

post_discord() { # $1 = title, $2 = description, $3 = color (decimal), $4 = optional JSON embed-fields array
  local url; url=$(get_webhook_url) || { log "no webhook configured; skipping Discord post"; return 0; }
  [ -z "$url" ] || [ "$url" = "None" ] && { log "no webhook configured; skipping Discord post"; return 0; }
  # Build the payload with jq so the name/avatar/text are safely JSON-escaped.
  local payload
  payload=$(jq -n --arg name "$PERSONA_NAME" --arg icon "$PERSONA_ICON" --arg thumb "$PERSONA_THUMB" \
    --arg footer "$PERSONA_FOOTER" \
    --arg title "$1" --arg desc "$2" --argjson color "$3" --argjson fields "${4:-[]}" \
    '{username: $name, embeds: [{title: $title, description: $desc, color: $color}]}
     | if $desc == "" then .embeds[0] |= del(.description) else . end
     | if $footer != "" then .embeds[0].footer = {text: $footer} else . end
     | if ($fields | length) > 0 then .embeds[0].fields = $fields else . end
     | if $thumb != "" then .embeds[0].thumbnail = {url: $thumb} else . end
     | if $icon != "" then .avatar_url = $icon else . end')
  curl -s -m 10 -H "Content-Type: application/json" -X POST "$url" -d "$payload" \
    > /dev/null 2>&1 || log "WARNING: Discord post failed"
}

# Dedup key for an event line: collapse the lloesche/Valheim "Console: [Info :
# Unity Log] <ts>:" mirror (each game line is logged twice, raw + console) so the
# two copies hash identically and we post once. No-op for games without it.
declare -A SEEN_EVENTS
event_key() { echo "$1" | sed -E 's/Console: \[Info : Unity Log\] [0-9/:. ]*//'; }

# Scan the recent log for each profile event and post NEW matches (deduped by
# event_key). $1="seed" marks current matches seen WITHOUT posting — called once
# at startup so a monitor (re)start doesn't replay the whole backlog. Edge-
# triggered: a short --since window (the count is the level-triggered one).
scan_events() { # $1 = mode ('seed' to suppress posts)
  [ "${EVENT_COUNT:-0}" -eq 0 ] && return 0
  local mode="$1" i id pattern title body nameSed color category dedupByName line key name t b logs
  # Read the window ONCE per cycle, then grep it per event (not one docker-logs
  # call per event — that was 16x for Valheim every cycle).
  logs=$(docker logs --since "${EVENT_WINDOW:-300s}" "$CONTAINER_NAME" 2>&1)
  for i in $(seq 0 $((EVENT_COUNT - 1))); do
    id=$(echo "$EVENTS_JSON" | jq -r ".[$i].id")
    pattern=$(echo "$EVENTS_JSON" | jq -r ".[$i].pattern")
    title=$(echo "$EVENTS_JSON" | jq -r ".[$i].title")
    body=$(echo "$EVENTS_JSON" | jq -r ".[$i].body // \"\"")
    nameSed=$(echo "$EVENTS_JSON" | jq -r ".[$i].nameSed // empty")
    color=$(echo "$EVENTS_JSON" | jq -r ".[$i].color // empty")
    [ -z "$color" ] && color="$PERSONA_COLOR"
    # Each event's notify category (a group of entries can share one, e.g. raids);
    # defaults to the event id. Toggled via `/<cmd> notify set <category> off`.
    category=$(echo "$EVENTS_JSON" | jq -r ".[$i] | .category // .id")
    dedupByName=$(echo "$EVENTS_JSON" | jq -r ".[$i].dedupByName // false")
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      name=""
      [ -n "$nameSed" ] && name=$(echo "$line" | sed -nE "${nameSed}p")
      # Dedup key, NAMESPACED by event id so two events matching the same line
      # (e.g. a death line also matches the spawn-based join) track separately.
      # dedupByName keys on the player so respawns don't re-announce a join.
      if [ "$dedupByName" = "true" ]; then key="${id}|n|${name}"; else key="${id}|l|$(event_key "$line")"; fi
      [ -n "${SEEN_EVENTS[$key]:-}" ] && continue
      SEEN_EVENTS[$key]=1
      [ "$mode" = "seed" ] && continue
      t=${title//\{name\}/$name}; b=${body//\{name\}/$name}
      notify_enabled "$category" && post_discord "$t" "$b" "$color"
    done < <(echo "$logs" | grep -aE "$pattern")
  done
}

# Seed once: mark everything already in the log as seen so a monitor (re)start
# mid-session doesn't replay the backlog of joins/deaths/raids as fresh posts.
scan_events seed

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
  elif [ -n "$PLAYERS_LOG_PATTERN" ] || [ -n "$LIVENESS_LOG_PATTERN" ]; then
    # A2S silent (e.g. crossplay Valheim -> PlayFab) — derive liveness + player
    # count from the server's own log over the FULL session, NOT a time window.
    # A player emits a "now N player(s)" line only at the instant they join, so a
    # windowed scrape reads 0 a few minutes later and idle-kills a connected
    # player (this idle-killed a friend mid-session). Reading the whole log means
    # that join line never scrolls out of view, so the count stays correct until
    # they actually leave.
    LOGS=$(docker logs "$CONTAINER_NAME" 2>&1)
    # Liveness: a heartbeat present even at 0 players once the server is joinable.
    if [ -n "$LIVENESS_LOG_PATTERN" ] && echo "$LOGS" | grep -qE "$LIVENESS_LOG_PATTERN"; then
      LIVE=true
    fi
    # Count: the LAST join/leave event's number is the current player count.
    if [ -n "$PLAYERS_LOG_PATTERN" ]; then
      MATCH=$(echo "$LOGS" | grep -oE "$PLAYERS_LOG_PATTERN" | tail -1)
      if [ -n "$MATCH" ]; then
        LIVE=true
        PLAYERS=$(echo "$MATCH" | grep -oE '[0-9]+' | tail -1)
        [[ "$PLAYERS" =~ ^[0-9]+$ ]] || PLAYERS=0
      fi
    fi
  fi

  # --- Event-bookkeeping count override (e.g. Abiotic Factor) ---
  # Some games answer A2S — so the liveness above is correct — but report 0
  # players because clients join over a relay A2S can't see (AF -> EOS; verified
  # live: A2S_INFO and A2S_PLAYER both 0 with a player connected). When the
  # profile defines join/leave EVENT patterns, derive the count from them instead
  # of A2S: net presence = (#joins − #leaves) over the FULL log. The full-log read
  # is deliberate — an early join must not scroll off while the player is still
  # on. Leaves LIVE as A2S set it (a stale join line must not keep a dead server
  # "live"). Caveat: an ungraceful disconnect logs no leave, so the count can stay
  # high — the server then stays up longer but never idle-kills a live player.
  if [ -n "$PLAYER_JOIN_PATTERN" ] && [ -n "$PLAYER_LEAVE_PATTERN" ]; then
    EVLOGS=$(docker logs "$CONTAINER_NAME" 2>&1)
    JOINS=$(echo "$EVLOGS" | grep -cE "$PLAYER_JOIN_PATTERN")
    LEAVES=$(echo "$EVLOGS" | grep -cE "$PLAYER_LEAVE_PATTERN")
    PLAYERS=$((JOINS - LEAVES))
    [ "$PLAYERS" -lt 0 ] && PLAYERS=0
    log "Event count: ${JOINS} joined − ${LEAVES} left = ${PLAYERS}"
  fi

  # --- Down-debounce: one missed check while live is UDP noise; two in a row
  #     (a cycle apart) is a real outage. Hold the last player count through a
  #     debounced blip so idle tracking and the SSM count don't see a phantom 0. ---
  if [ "$LIVE" = true ]; then
    MISS_COUNT=0
  elif [ -f "$LIVE_STATE_FILE" ]; then
    MISS_COUNT=$((MISS_COUNT + 1))
    if [ "$MISS_COUNT" -lt 2 ]; then
      log "Liveness check missed once — debouncing (treating as still live)"
      LIVE=true
      PLAYERS=$LAST_PLAYERS
    fi
  fi
  LAST_PLAYERS=$PLAYERS

  # --- Readiness: first transition to live this session ---
  WAS_LIVE=$( [ -f "$LIVE_STATE_FILE" ] && echo 1 || echo 0 )
  if [ "$LIVE" = true ]; then
    echo 1 > "$LIVE_STATE_FILE"
    [ "$WAS_LIVE" = 0 ] && put_param "$SERVER_LIVE_PARAM" "true"
    # Per-session lobby/join code: re-scraped EVERY live cycle (the pattern comes
    # from the profile; the code is the last token of the latest match) because
    # crossplay codes can rotate mid-session when the server re-registers with
    # PlayFab. SSM is rewritten only when the code actually changes.
    JOIN_CODE=""
    if [ -n "$JOIN_CODE_PATTERN" ]; then
      JOIN_CODE=$(docker logs "$CONTAINER_NAME" 2>&1 | grep -oE "$JOIN_CODE_PATTERN" | tail -1 | awk '{print $NF}')
      if [ -n "$JOIN_CODE" ] && [ "$JOIN_CODE" != "$PUBLISHED_JOIN_CODE" ]; then
        put_param "$JOIN_CODE_PARAM" "$JOIN_CODE"
        PUBLISHED_JOIN_CODE="$JOIN_CODE"
        log "Session join code: $JOIN_CODE"
      fi
    fi
    if [ ! -f "$SEEN_LIVE_FLAG" ]; then
      touch "$SEEN_LIVE_FLAG"
      # Prefer the stable derived domain; fall back to the public IP.
      JOIN_HOST="${GAME_DOMAIN:-}"
      [ -z "$JOIN_HOST" ] && JOIN_HOST=$(imds public-ipv4)
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
      # Surface the idle auto-shutoff so players know the box turns itself off
      # (same window the idle path below enforces; mirrors /<cmd> status).
      ASD=$(aws ssm get-parameter --name "$AUTO_SHUTDOWN_PARAM" --region "$REGION" --query 'Parameter.Value' --output text 2>/dev/null || echo "15")
      if [ "$ASD" = "off" ] || [ "$ASD" = "disabled" ]; then
        DESC="${DESC}
💤 Auto-shutdown is off — remember to \`${SLASH_CMD} stop\` when you're done."
      else
        DESC="${DESC}
💤 Shuts down automatically after ${ASD} min idle."
      fi
      notify_enabled online && post_discord "🟢 Server Online" "$DESC" 3776160 "$JOIN_FIELDS"
    fi
  else
    rm -f "$LIVE_STATE_FILE"
    [ "$WAS_LIVE" = 1 ] && put_param "$SERVER_LIVE_PARAM" "false"
  fi

  # --- Player count -> SSM + CloudWatch ---
  log "Players: $PLAYERS (live=$LIVE)"
  aws ssm put-parameter --name "$PLAYER_COUNT_PARAM" --type String --value "$PLAYERS" --overwrite --region "$REGION" > /dev/null 2>&1
  aws cloudwatch put-metric-data --namespace "$NAMESPACE" --metric-name PlayerCount \
    --value "$PLAYERS" --unit Count --region "$REGION" > /dev/null 2>&1

  # --- Flavor events -> Discord (deaths, raids, joins; deduped, gated by toggle) ---
  scan_events

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
        notify_enabled failed && post_discord "⚠️ Server Failed to Start" "The server didn't come online within ${BOOT_TIMEOUT} minutes — stopping to avoid charges.
Try \`${SLASH_CMD} start\` again (the next boot is faster, the download is cached)." 15158332
        invalidate_session_params
        aws ec2 stop-instances --instance-ids "$INSTANCE_ID" --region "$REGION"
        break
      fi
    fi
  fi

  # --- Idle tracking / auto-shutdown (only after the server has been live once,
  #     so a slow first boot under Wine+SteamCMD is never mistaken for idle) ---
  AUTO_SHUTDOWN=$(aws ssm get-parameter --name "$AUTO_SHUTDOWN_PARAM" --region "$REGION" --query 'Parameter.Value' --output text 2>/dev/null || echo "15")
  if [ "$PLAYERS" -gt 0 ]; then
    echo "$NOW" > "$ACTIVITY_FILE"
  elif [ -f "$SEEN_LIVE_FLAG" ] && [ "$AUTO_SHUTDOWN" != "off" ] && [ "$AUTO_SHUTDOWN" != "disabled" ]; then
    THRESHOLD=$((AUTO_SHUTDOWN * 60))
    LAST=$(cat "$ACTIVITY_FILE" 2>/dev/null || echo "$NOW")
    IDLE=$((NOW - LAST))
    log "Idle for ${IDLE}s (threshold ${THRESHOLD}s)"
    if [ "$IDLE" -gt "$THRESHOLD" ]; then
      log "Idle threshold exceeded — backing up and shutting down"
      notify_enabled idle && post_discord "💤 Server Idle" "No players for ${AUTO_SHUTDOWN} min. Backing up and shutting down." 16763904
      /usr/local/bin/backup-server.sh || log "WARNING: backup failed; stopping anyway (data persists on EBS)"
      invalidate_session_params
      aws ec2 stop-instances --instance-ids "$INSTANCE_ID" --region "$REGION"
      break
    fi
  fi

  # Two-speed cadence: fast until the first liveness this session — boot is
  # exactly when people are watching Discord for the readiness ping/join code —
  # then relaxed, since idle accounting only needs minute resolution.
  if [ -f "$SEEN_LIVE_FLAG" ]; then sleep 120; else sleep 15; fi
done
