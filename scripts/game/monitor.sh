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
# Pre-live boot stages (see GameProfile.bootPhases): {id,pattern,label,emoji?,
# progressPattern?,failure?}, matched against the full container log.
BOOT_PHASES_JSON=$(jq -c '.bootPhases // []' "$PROFILE")
BOOT_PHASE_COUNT=$(echo "$BOOT_PHASES_JSON" | jq 'length')
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
BOOT_PHASE_PARAM="/gatekeeper/${GAME_ID}/boot-phase"       # JSON of the current pre-live stage; 'none' once live
PINNED_STATUS_PREFIX="/gatekeeper/${GAME_ID}/pinned-status" # per-guild durable pinned message: {messageId,channelId}
BOT_TOKEN_PARAM="/gatekeeper/${GAME_ID}/discord-bot-token"  # SecureString; the pin API needs a bot, webhooks can't pin
SESSION_STARTER_PARAM="/gatekeeper/${GAME_ID}/session-starter" # who ran /<cmd> start, pinged when a boot fails
SESSION_PRIVATE_PARAM="/gatekeeper/${GAME_ID}/session-private" # 'true' = quiet session: skip the public online ping
STATUS_MSG_PARAM="/gatekeeper/${GAME_ID}/status-message-id"    # readiness message id; the offline lambda edits it in place
EXTEND_MINUTES_PARAM="/gatekeeper/${GAME_ID}/extend-minutes"   # Extend button: minutes of idle grace per press ('off' = disabled)
EXTEND_UNTIL_PARAM="/gatekeeper/${GAME_ID}/extend-until"       # epoch-ms to hold off idle-shutdown until (Extend button writes it)
DISPLAY_NAME=$(jq -r '.displayName // "Server"' "$PROFILE")    # fallback status-message title when no world name is set

# Status-message button rows. custom_ids / styles MUST match the handlers in
# lib/lambdas/commands/component.ts (a Cancel there re-renders this same row).
BTN_STOP='{"type":2,"style":4,"label":"🛑 Stop","custom_id":"gk_stop"}'
BTN_EXTEND='{"type":2,"style":1,"label":"⏰ Extend","custom_id":"gk_extend"}'
BTN_RESTART='{"type":2,"style":1,"label":"🔄 Restart server","custom_id":"gk_restart"}'

put_param() { # $1 = name, $2 = value (best-effort)
  aws ssm put-parameter --name "$1" --type String --value "$2" --overwrite \
    --region "$REGION" > /dev/null 2>&1
}
# Invalidate the previous session in SSM: the join code is per-session, so until
# this run's scrape lands, /gate join|status must see 'none' — not last run's
# dead code. server-live=false tells the lambdas the game isn't joinable yet.
# extend-until is cleared so a stale Extend grace never leaks into the next session.
invalidate_session_params() {
  put_param "$JOIN_CODE_PARAM" "none"
  put_param "$SERVER_LIVE_PARAM" "false"
  put_param "$EXTEND_UNTIL_PARAM" "0"
}

# Fresh session: clear edge/idle state so stale files can't trigger an instant shutdown.
rm -f "$SEEN_LIVE_FLAG" "$LIVE_STATE_FILE"
date +%s > "$ACTIVITY_FILE"
invalidate_session_params
# Drop LAST session's readiness message id at startup ONLY (not in
# invalidate_session_params, which also runs pre-stop — clearing it there would
# wipe the id before the offline lambda can edit this session's message). This
# session's post_status overwrites it; a suppressed/private online leaves 'none'.
put_param "$STATUS_MSG_PARAM" "none"
put_param "$BOOT_PHASE_PARAM" "none"
MISS_COUNT=0          # consecutive failed liveness checks (for down-debounce)
LAST_PLAYERS=0        # last good player count (held through a debounced blip)
PUBLISHED_BTN="show"  # status-message button state ("show"=Extend visible / "hide"); the first-live post uses live_controls(0)=show
PUBLISHED_JOIN_CODE="" # join code currently in SSM (rewrite only on change)
PUBLISHED_BOOT_PHASE="" # "<id>:<progress>" currently published (rewrite only on change)
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

# Build the webhook payload with jq so name/avatar/text are safely JSON-escaped.
# $5 (components) is always emitted — pass [] to explicitly CLEAR buttons on an
# edit (a webhook message-edit leaves omitted fields unchanged, so [] is required
# to remove them at winding-down/offline).
build_payload() { # $1=title $2=description $3=color $4=fields JSON $5=components JSON $6=optional content (pings)
  jq -n --arg name "$PERSONA_NAME" --arg icon "$PERSONA_ICON" --arg thumb "$PERSONA_THUMB" \
    --arg footer "$PERSONA_FOOTER" \
    --arg title "$1" --arg desc "$2" --argjson color "$3" --argjson fields "${4:-[]}" \
    --argjson components "${5:-[]}" --arg content "${6:-}" \
    '{username: $name, embeds: [{title: $title, description: $desc, color: $color}], components: $components}
     | if $content != "" then .content = $content
         | .allowed_mentions = {parse: [], users: ([$content | scan("<@!?([0-9]+)>")] | flatten)}
       else . end
     | if $desc == "" then .embeds[0] |= del(.description) else . end
     | if $footer != "" then .embeds[0].footer = {text: $footer} else . end
     | if ($fields | length) > 0 then .embeds[0].fields = $fields else . end
     | if $thumb != "" then .embeds[0].thumbnail = {url: $thumb} else . end
     | if $icon != "" then .avatar_url = $icon else . end'
}

# The world's display name — the constant title across the status message's whole
# lifecycle (Online -> Winding Down -> Offline), so it reads as one message
# updating rather than a new post each state. Falls back to the game name.
world_title() {
  local t
  t=$(aws ssm get-parameter --name "$ACTIVE_WORLD_PARAM" --region "$REGION" --query 'Parameter.Value' --output text 2>/dev/null | jq -r '.name // .worldName // empty' 2>/dev/null)
  if [ -n "$t" ] && [ "$t" != "null" ]; then echo "$t"; else echo "$DISPLAY_NAME"; fi
}

# Live-controls action row for the status message: Stop always; Extend only while
# the idle clock actually runs (0 players) AND the feature is enabled. $1 = player count.
live_controls() {
  local extend_min
  extend_min=$(aws ssm get-parameter --name "$EXTEND_MINUTES_PARAM" --region "$REGION" --query 'Parameter.Value' --output text 2>/dev/null || echo "5")
  if [ "${1:-0}" -ge 1 ] || [ "$extend_min" = "off" ] || [ "$extend_min" = "disabled" ]; then
    echo "[{\"type\":1,\"components\":[${BTN_STOP}]}]"
  else
    echo "[{\"type\":1,\"components\":[${BTN_STOP},${BTN_EXTEND}]}]"
  fi
}

# PATCH ONLY the status message's button row (leaves the embed untouched), used to
# show/hide Extend as the player count crosses 0<->1. No-op if there's no message.
set_buttons() { # $1 = components JSON array
  local url id
  id=$(aws ssm get-parameter --name "$STATUS_MSG_PARAM" --region "$REGION" --query 'Parameter.Value' --output text 2>/dev/null || echo "none")
  if [ -z "$id" ] || [ "$id" = "none" ]; then return 1; fi
  url=$(get_webhook_url) || return 1
  if [ -z "$url" ] || [ "$url" = "None" ]; then return 1; fi
  curl -s -m 10 -H "Content-Type: application/json" -X PATCH "${url}/messages/${id}" \
    -d "{\"components\": $1}" > /dev/null 2>&1
}

# 'yes' while the Extend-button grace is still in effect (NOW is before the
# extend-until instant, stored as epoch-ms). Non-numeric/absent counts as expired.
extend_active() {
  local until now_ms
  until=$(aws ssm get-parameter --name "$EXTEND_UNTIL_PARAM" --region "$REGION" --query 'Parameter.Value' --output text 2>/dev/null || echo "0")
  case "$until" in ''|*[!0-9]*) until=0 ;; esac
  now_ms=$(( $(date +%s) * 1000 ))
  if [ "$until" -gt "$now_ms" ]; then echo "yes"; else echo "no"; fi
}

post_discord() { # $1 = title, $2 = description, $3 = color (decimal), $4 = optional JSON embed-fields array
  local url payload
  url=$(get_webhook_url) || { log "no webhook configured; skipping Discord post"; return 0; }
  if [ -z "$url" ] || [ "$url" = "None" ]; then log "no webhook configured; skipping Discord post"; return 0; fi
  payload=$(build_payload "$1" "$2" "$3" "${4:-[]}")
  curl -s -m 10 -H "Content-Type: application/json" -X POST "$url" -d "$payload" \
    > /dev/null 2>&1 || log "WARNING: Discord post failed"
}

# Like post_discord but posts with ?wait=true and stores the created message id in
# SSM, so the offline lambda can EDIT this readiness message in place (Online ->
# Offline) instead of posting a second message. Used for the one-per-session ping.
post_status() { # $1=title $2=description $3=color $4=optional fields JSON $5=optional components JSON
  local url payload resp id
  url=$(get_webhook_url) || { log "no webhook configured; skipping Discord post"; return 0; }
  if [ -z "$url" ] || [ "$url" = "None" ]; then log "no webhook configured; skipping Discord post"; return 0; fi
  payload=$(build_payload "$1" "$2" "$3" "${4:-[]}" "${5:-[]}" "${6:-}")
  resp=$(curl -s -m 10 -H "Content-Type: application/json" -X POST "${url}?wait=true" -d "$payload" 2>/dev/null)
  id=$(echo "$resp" | jq -r '.id // empty' 2>/dev/null)
  if [ -n "$id" ]; then put_param "$STATUS_MSG_PARAM" "$id"; else log "WARNING: readiness post failed (no message id captured)"; fi
}

# Edit this session's status message in place (Online -> winding down -> Offline).
# Returns non-zero when there's no message to edit (online was suppressed/off), so
# callers can fall back to a fresh post. Editing is silent (no re-ping).
edit_status() { # $1=title $2=description $3=color $4=optional fields JSON $5=optional components JSON
  local url id payload code
  id=$(aws ssm get-parameter --name "$STATUS_MSG_PARAM" --region "$REGION" --query 'Parameter.Value' --output text 2>/dev/null || echo "none")
  if [ -z "$id" ] || [ "$id" = "none" ]; then return 1; fi
  url=$(get_webhook_url) || return 1
  if [ -z "$url" ] || [ "$url" = "None" ]; then return 1; fi
  payload=$(build_payload "$1" "$2" "$3" "${4:-[]}" "${5:-[]}" "${6:-}")
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 -H "Content-Type: application/json" \
    -X PATCH "${url}/messages/${id}" -d "$payload" 2>/dev/null)
  case "$code" in
    2??) return 0 ;;
    # The message no longer exists — report failure so the caller can recreate.
    # Only 404 does this: transient errors (5xx, timeouts) must NOT, or a
    # Discord blip would spawn a duplicate status message.
    404) log "status message $id gone (HTTP 404)"; return 1 ;;
    *)   log "WARNING: status message edit failed (HTTP ${code:-timeout})"; return 0 ;;
  esac
}

# The active world's guild id (the pinned message is per-Discord-server).
active_guild() {
  aws ssm get-parameter --name "$ACTIVE_WORLD_PARAM" --region "$REGION" --query "Parameter.Value" \
    --output text 2>/dev/null | jq -r '.discordServerId // empty' 2>/dev/null
}

# The guild's durable pinned message as "<messageId> <channelId>", if it has one.
pinned_status() {
  local guild v
  guild=$(active_guild) || return 1
  [ -z "$guild" ] && return 1
  v=$(aws ssm get-parameter --name "${PINNED_STATUS_PREFIX}/${guild}" --region "$REGION" \
        --query 'Parameter.Value' --output text 2>/dev/null) || return 1
  case "$v" in ''|None|none) return 1 ;; esac
  echo "$v" | jq -r 'if .messageId and .channelId then "\(.messageId) \(.channelId)" else empty end' 2>/dev/null
}

# Pin a message with the BOT token — webhooks cannot pin, so this is the one
# place the monitor needs the bot identity. Requires MANAGE_MESSAGES in the
# channel; a 403 here means the bot is missing that permission (logged, not
# fatal: an unpinned status message still works, it just isn't pinned).
pin_message() { # $1 = channel id, $2 = message id
  local token code
  token=$(aws ssm get-parameter --name "$BOT_TOKEN_PARAM" --with-decryption --region "$REGION" \
            --query 'Parameter.Value' --output text 2>/dev/null)
  if [ -z "$token" ] || [ "$token" = "None" ]; then
    log "WARNING: no bot token at $BOT_TOKEN_PARAM — cannot pin (seed it with 'npm run cli discord put-token')"
    return 1
  fi
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 -X PUT \
    -H "Authorization: Bot ${token}" -H "Content-Length: 0" \
    "https://discord.com/api/v10/channels/$1/pins/$2")
  case "$code" in
    204|200) log "Pinned status message $2 in channel $1"; return 0 ;;
    403) log "WARNING: pin refused (403) — the bot needs Manage Messages in channel $1 (re-invite: 'npm run cli discord invite-url'; note channel overwrites beat server roles)"; return 1 ;;
    *)   log "WARNING: pin failed (HTTP $code) for message $2"; return 1 ;;
  esac
}

# Create the guild's durable status message, once. Lives on the host rather than
# in a Lambda because the webhook's ?wait=true response is the only place the
# channel_id needed for the pin comes from.
create_pinned_status() { # $1=title $2=description $3=color $4=fields $5=components
  local url payload resp id channel guild
  guild=$(active_guild); [ -z "$guild" ] && return 1
  url=$(get_webhook_url) || return 1
  [ -z "$url" ] || [ "$url" = "None" ] && return 1
  payload=$(build_payload "$1" "$2" "$3" "${4:-[]}" "${5:-[]}" "${6:-}")
  resp=$(curl -s -m 10 -H "Content-Type: application/json" -X POST "${url}?wait=true" -d "$payload" 2>/dev/null)
  id=$(echo "$resp" | jq -r '.id // empty' 2>/dev/null)
  channel=$(echo "$resp" | jq -r '.channel_id // empty' 2>/dev/null)
  [ -z "$id" ] || [ -z "$channel" ] && { log "WARNING: could not create pinned status message"; return 1; }
  pin_message "$channel" "$id" || true   # keep the message even if pinning is refused
  put_param "${PINNED_STATUS_PREFIX}/${guild}" "$(jq -nc --arg m "$id" --arg c "$channel" '{messageId: $m, channelId: $c}')"
  # The offline Lambda edits STATUS_MSG_PARAM, so point it at the same message.
  put_param "$STATUS_MSG_PARAM" "$id"
  log "Created durable pinned status message $id in channel $channel"
}

# Post the status message, or edit the existing one. Boot progress and the Online
# embed are deliberately the SAME message, so a session reads as one post updating
# rather than stranding a stale "Downloading…" above the join details.
status_upsert() { # same args as post_status (incl. optional $6 content)
  local pinned id channel
  # The pinned message, when one exists, is always the target.
  if pinned=$(pinned_status) && [ -n "$pinned" ]; then
    id=${pinned%% *}
    channel=${pinned##* }
    # Re-pin once per boot: pinning an already-pinned message is a no-op, so
    # this only matters when someone unpinned it by hand — it comes back.
    if [ "${REPINNED:-0}" != "1" ]; then
      pin_message "$channel" "$id" || true
      REPINNED=1
    fi
    # Keep the session pointer aligned so the offline Lambda edits this message too.
    [ "$(aws ssm get-parameter --name "$STATUS_MSG_PARAM" --region "$REGION" --query 'Parameter.Value' --output text 2>/dev/null)" != "$id" ] \
      && put_param "$STATUS_MSG_PARAM" "$id"
    edit_status "$@" && return 0
    # The pinned message is gone (deleted by hand) — forget it and recreate below.
    log "pinned status message missing; recreating"
    put_param "${PINNED_STATUS_PREFIX}/$(active_guild)" "none"
  fi
  create_pinned_status "$@" && return 0
  edit_status "$@" || post_status "$@"
}

# Echo the current pre-live stage as compact JSON, or return 1 if none matches.
# Resolution per GameProfile.bootPhases: a `failure` entry wins outright (a stale
# build keeps logging LATER phases after its update fails), else the last match.
detect_boot_phase() {
  [ "${BOOT_PHASE_COUNT:-0}" -eq 0 ] && return 1
  local logs entry pat winner="" i=0 prog_pat prog=""
  logs=$(docker logs "$CONTAINER_NAME" 2>&1) || return 1
  [ -z "$logs" ] && return 1
  while [ "$i" -lt "$BOOT_PHASE_COUNT" ]; do
    entry=$(echo "$BOOT_PHASES_JSON" | jq -c ".[$i]")
    i=$((i + 1))
    pat=$(echo "$entry" | jq -r '.pattern // empty')
    [ -z "$pat" ] && continue
    echo "$logs" | grep -qE "$pat" || continue
    winner="$entry"
    [ "$(echo "$entry" | jq -r '.failure // false')" = "true" ] && break
  done
  [ -z "$winner" ] && return 1
  # Progress = last numeric token of the pattern's last match ("progress: 42.39").
  prog_pat=$(echo "$winner" | jq -r '.progressPattern // empty')
  if [ -n "$prog_pat" ]; then
    prog=$(echo "$logs" | grep -oE "$prog_pat" | tail -1 | grep -oE '[0-9]+(\.[0-9]+)?' | tail -1)
  fi
  echo "$winner" | jq -c --arg prog "$prog" --argjson at "$(date +%s)" \
    '{id, label, emoji: (.emoji // "\u23f3"), failure: (.failure // false), at: $at}
     + (if $prog != "" then {progress: ($prog | tonumber)} else {} end)'
}

# Dedup key for an event line: collapse the lloesche/Valheim "Console: [Info :
# Unity Log] <ts>:" mirror (each game line is logged twice, raw + console) so the
# two copies hash identically and we post once. No-op for games without it.
declare -A SEEN_EVENTS
# Events held one cycle for confirmation (GameEvent.confirmDrop). Valheim logs
# "Player connection lost" on any transient drop, so announcing on the raw line
# spams a departure notice every time someone blips out and walks straight back
# in — the count is the ground truth, so we wait a cycle and check it.
declare -A PENDING_EVENTS
event_key() { echo "$1" | sed -E 's/Console: \[Info : Unity Log\] [0-9/:. ]*//'; }

# Scan the recent log for each profile event and post NEW matches (deduped by
# event_key). $1="seed" marks current matches seen WITHOUT posting — called once
# at startup so a monitor (re)start doesn't replay the whole backlog. Edge-
# triggered: a short --since window (the count is the level-triggered one).
scan_events() { # $1 = mode ('seed' to suppress posts)
  [ "${EVENT_COUNT:-0}" -eq 0 ] && return 0
  local mode="$1" i id pattern title body nameSed color category dedupByName confirmDrop line key name t b logs
  local pk pval pcount pcat pcolor ptitle pbody
  # Resolve anything held from last cycle FIRST: post it only if the player count
  # has not recovered. A reconnect cancels the notice entirely. Imperfect when
  # several players churn at once (the count is a whole-server number, not a
  # per-player one) — acceptable for flavor posts, and it errs toward silence.
  for pk in "${!PENDING_EVENTS[@]}"; do
    pval=${PENDING_EVENTS[$pk]}
    unset 'PENDING_EVENTS[$pk]'
    IFS=$'\x1f' read -r pcount pcat pcolor ptitle pbody <<< "$pval"
    if [ "${PLAYERS:-0}" -le "${pcount:-0}" ]; then
      notify_enabled "$pcat" && post_discord "$ptitle" "$pbody" "$pcolor"
    else
      log "Held event '${pk%%|*}' dropped — count recovered ${pcount} -> ${PLAYERS} (reconnect)"
    fi
  done
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
    confirmDrop=$(echo "$EVENTS_JSON" | jq -r ".[$i].confirmDrop // false")
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
      # \x1f-delimited so titles/bodies containing punctuation survive the round trip.
      if [ "$confirmDrop" = "true" ]; then
        PENDING_EVENTS[$key]=$(printf '%s\x1f%s\x1f%s\x1f%s\x1f%s' "${PLAYERS:-0}" "$category" "$color" "$t" "$b")
        continue
      fi
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
      # The boot is over: drop the phase so `/<cmd> status` stops reporting one.
      put_param "$BOOT_PHASE_PARAM" "none"
      PUBLISHED_BOOT_PHASE=""
      # Anchor the idle clock to first-live, not monitor start. Otherwise a slow
      # boot (e.g. a fresh Steam download) burns into the idle grace window — with
      # a 12-min boot and a 15-min auto-shutdown, a player-less session would
      # idle-stop ~3 min after coming online instead of getting the full grace.
      echo "$NOW" > "$ACTIVITY_FILE"
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
      # Unified status message: a constant world-name title with a status line
      # leading the body, so Online -> Winding Down -> Offline reads as ONE message
      # updating. WTITLE is the title across every state; BTNS is the live-controls
      # row (Stop always, Extend while idle). Status line carries the 🟢/💤/🛑 cue.
      WTITLE=$(world_title)
      BTNS=$(live_controls "$PLAYERS")
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
      # Private (quiet) session: skip the public readiness broadcast entirely —
      # players pull join details privately via `/<cmd> join`. `/<cmd> open`
      # flips this flag off (and posts the announcement itself if already live).
      SESSION_PRIVATE=$(aws ssm get-parameter --name "$SESSION_PRIVATE_PARAM" --region "$REGION" --query 'Parameter.Value' --output text 2>/dev/null || echo "false")
      if [ "$SESSION_PRIVATE" = "true" ]; then
        # Private session: a MINIMAL cue so invited friends know to pull the
        # details, but WITHOUT the address/password/code (those come privately via
        # `/<cmd> join`). post_status captures the id so the lifecycle still edits
        # this one message (cue -> Offline). "Private" here is quiet, not locked —
        # anyone in the channel could /join; true lockout needs a separate world.
        notify_enabled online && status_upsert "$WTITLE" "🔒 **Private — Live**
Run \`${SLASH_CMD} join\` when the bot's status shows it's playing the game. The join address is never posted to the channel. Make the game public with \`${SLASH_CMD} open\`." 10181046 "[]" "$BTNS"
      else
        # post_status captures the message id so the offline lambda edits THIS
        # message into the offline state (one message, Online -> Offline).
        notify_enabled online && status_upsert "$WTITLE" "🟢 **Online**
$DESC" 3776160 "$JOIN_FIELDS" "$BTNS"
      fi
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

  # --- Memory headroom -> CloudWatch, alongside the player count so the two can be
  #     read against each other: "how much RAM was left at N players" is the
  #     question, and EC2 publishes no memory metric of its own. Host-level
  #     (/proc/meminfo), so it covers the game container plus everything else.
  #     MemAvailable, not MemFree — free excludes reclaimable page cache and reads
  #     alarmingly low on a healthy box. Dimensioned by game because the namespace
  #     is shared between them. ---
  MEM_TOTAL_MB=$(awk '/^MemTotal:/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null)
  MEM_AVAIL_MB=$(awk '/^MemAvailable:/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null)
  if [ -n "$MEM_TOTAL_MB" ] && [ -n "$MEM_AVAIL_MB" ] && [ "$MEM_TOTAL_MB" -gt 0 ]; then
    MEM_USED_PCT=$(( (MEM_TOTAL_MB - MEM_AVAIL_MB) * 100 / MEM_TOTAL_MB ))
    log "Memory: ${MEM_AVAIL_MB}MB available of ${MEM_TOTAL_MB}MB (${MEM_USED_PCT}% used)"
    aws cloudwatch put-metric-data --namespace "$NAMESPACE" --region "$REGION" \
      --dimensions "Game=${GAME_ID}" \
      --metric-name MemoryAvailableMB --value "$MEM_AVAIL_MB" --unit Megabytes > /dev/null 2>&1
    aws cloudwatch put-metric-data --namespace "$NAMESPACE" --region "$REGION" \
      --dimensions "Game=${GAME_ID}" \
      --metric-name MemoryUsedPercent --value "$MEM_USED_PCT" --unit Percent > /dev/null 2>&1
  fi

  # --- Extend button: only useful at 0 players (idle clock is paused otherwise),
  #     so show/hide it on the 0<->1 crossing by PATCHing just the message's row.
  #     Edge-triggered off PUBLISHED_BTN so we don't PATCH every cycle. ---
  if [ "$LIVE" = true ]; then
    if [ "$PLAYERS" -ge 1 ]; then DESIRED_BTN="hide"; else DESIRED_BTN="show"; fi
    if [ "$DESIRED_BTN" != "$PUBLISHED_BTN" ]; then
      if set_buttons "$(live_controls "$PLAYERS")"; then
        PUBLISHED_BTN="$DESIRED_BTN"
        log "Extend button -> $DESIRED_BTN (players=$PLAYERS)"
      fi
    fi
  fi

  # --- Flavor events -> Discord (deaths, raids, joins; deduped, gated by toggle) ---
  scan_events

  # --- Boot progress -> SSM (drives `/<cmd> status`) + the status message.
  #     Private sessions post nothing to the channel; the SSM value still feeds
  #     their ephemeral status. Gated on `online` as well as `boot` so a channel
  #     that opted out of readiness pings can't strand a boot message mid-phase
  #     with no Online edit to follow. ---
  if [ ! -f "$SEEN_LIVE_FLAG" ] && PHASE_JSON=$(detect_boot_phase); then
    PHASE_ID=$(echo "$PHASE_JSON" | jq -r '.id')
    PHASE_PROG=$(echo "$PHASE_JSON" | jq -r '.progress // empty')
    # Re-publish only on a real change; a download re-renders as its % moves.
    if [ "${PHASE_ID}:${PHASE_PROG}" != "$PUBLISHED_BOOT_PHASE" ]; then
      PUBLISHED_BOOT_PHASE="${PHASE_ID}:${PHASE_PROG}"
      put_param "$BOOT_PHASE_PARAM" "$PHASE_JSON"
      log "Boot phase: ${PHASE_ID}${PHASE_PROG:+ (${PHASE_PROG}%)}"
      PHASE_LINE="$(echo "$PHASE_JSON" | jq -r '.emoji') **$(echo "$PHASE_JSON" | jq -r '.label')**"
      [ -n "$PHASE_PROG" ] && PHASE_LINE="${PHASE_LINE} — ${PHASE_PROG}%"
      BOOT_PRIVATE=$(aws ssm get-parameter --name "$SESSION_PRIVATE_PARAM" --region "$REGION" --query 'Parameter.Value' --output text 2>/dev/null || echo "false")
      if [ "$BOOT_PRIVATE" != "true" ] && notify_enabled boot && notify_enabled online; then
        if [ "$(echo "$PHASE_JSON" | jq -r '.failure')" = "true" ]; then
          # Terminal. Extend is absent (no idle clock to extend), and this does
          # NOT stop the instance: the box may still serve an older build, so
          # teardown stays the operator's call with boot-timeout as the backstop.
          # Ping whoever ran `start` — a failure nobody sees is the whole problem.
          STARTER=$(aws ssm get-parameter --name "$SESSION_STARTER_PARAM" --region "$REGION" --query 'Parameter.Value' --output text 2>/dev/null || echo "none")
          PING=""
          case "$STARTER" in ''|none|None) ;; *) PING="<@${STARTER}>" ;; esac
          status_upsert "$(world_title)" "${PHASE_LINE}

The server came up, but its game files are out of date — clients will be turned away with a version error. **Restart** re-runs the update; if it fails again the files need a manual reinstall. Use \`${SLASH_CMD} stop\` if you'd rather shut it down." 15158332 "[]" "[{\"type\":1,\"components\":[${BTN_RESTART},${BTN_STOP}]}]" "$PING"
        else
          status_upsert "$(world_title)" "${PHASE_LINE}

Hang tight — the join details post here as soon as the server is ready." 16766720 "[]" "[]"
        fi
      fi
    fi
  fi

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
  elif [ -f "$SEEN_LIVE_FLAG" ] && [ "$AUTO_SHUTDOWN" != "off" ] && [ "$AUTO_SHUTDOWN" != "disabled" ] && [ "$(extend_active)" = "yes" ]; then
    # Extend button pressed: hold off idle-shutdown until the grace expires. When
    # it does, the next cycle finds ACTIVITY_FILE stale and shuts down promptly —
    # i.e. "N more minutes, then idle-stop", the intended semantic.
    log "Idle, but Extend grace is active — holding off shutdown"
  elif [ -f "$SEEN_LIVE_FLAG" ] && [ "$AUTO_SHUTDOWN" != "off" ] && [ "$AUTO_SHUTDOWN" != "disabled" ]; then
    THRESHOLD=$((AUTO_SHUTDOWN * 60))
    LAST=$(cat "$ACTIVITY_FILE" 2>/dev/null || echo "$NOW")
    IDLE=$((NOW - LAST))
    log "Idle for ${IDLE}s (threshold ${THRESHOLD}s)"
    if [ "$IDLE" -gt "$THRESHOLD" ]; then
      log "Idle threshold exceeded — backing up and shutting down"
      # Edit the live status message (the online ping OR the private cue) into the
      # winding-down state — same constant world-name title, status line flips to
      # 💤, join fields + buttons cleared ([] [] ). Editing is silent (correct in a
      # private session too). Only fall back to a standalone idle notice (a NEW
      # post) when the session is public AND there's no message to edit.
      IDLE_PRIVATE=$(aws ssm get-parameter --name "$SESSION_PRIVATE_PARAM" --region "$REGION" --query 'Parameter.Value' --output text 2>/dev/null || echo "false")
      if edit_status "$(world_title)" "💤 **Winding down** — backing up & shutting down.
No players for ${AUTO_SHUTDOWN} min." 16763904 "[]" "[]"; then
        log "Edited status message to winding-down"
      elif [ "$IDLE_PRIVATE" != "true" ] && notify_enabled idle; then
        post_discord "💤 Server Idle" "No players for ${AUTO_SHUTDOWN} min. Backing up and shutting down." 16763904
      fi
      /usr/local/bin/backup-server.sh --shutdown || log "WARNING: backup failed; stopping anyway (data persists on EBS)"
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
