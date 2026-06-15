#!/bin/bash
set -euo pipefail
#
# Game-agnostic save backup: archive the active game's whole persistent data
# volume and upload it to S3. The RETAIN'd EBS volume already persists data
# across stop/start, so this is for disaster recovery + the CLI download-to-local
# flow, not a prerequisite for shutdown.
#
# We back up the ENTIRE data/saves volume (not just the world dir) so we also
# capture things that live alongside the worlds — for Abiotic Factor that's the
# admin list (SaveGames/Server/Admin.ini) and server config (Config/WindowsServer),
# which sit outside savePath. Logs + crash reports are excluded as disposable.
# This restores byte-for-byte by extracting back into the data mount.
#
# Layout in S3: backups/<game-id>/<timestamp>.tar.gz
# The data volume is the LAST volume in the profile (convention: game binaries
# first, persistent saves last); savePath is relative to it.

PROFILE=/etc/gatekeeper/game-profile.json
CONF=/etc/gatekeeper.conf

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') - $1"; }

# IMDSv2-aware metadata fetch (AL2023 enforces token auth; works on optional too).
imds() {
  local t
  t=$(curl -s -m 5 -X PUT http://169.254.169.254/latest/api/token \
        -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
  curl -s -m 5 -H "X-aws-ec2-metadata-token: $t" \
        "http://169.254.169.254/latest/meta-data/$1"
}

[ -f "$CONF" ] && source "$CONF"
REGION=$(imds placement/region)
BUCKET="${GATEKEEPER_BUCKET:-}"
[ -z "$BUCKET" ] && { log "ERROR: GATEKEEPER_BUCKET not set"; exit 1; }

GAME_ID=$(jq -r '.id' "$PROFILE")
DATA_HOST=$(jq -r '.volumes[-1].hostPath' "$PROFILE")

# Persona webhook post (same pattern as monitor.sh) so every backup — manual
# stop, idle shutdown, or `cli backup create` — confirms itself in Discord.
PERSONA_NAME=$(jq -r '.persona.characterName // "GATEKeeper"' "$PROFILE")
PERSONA_THUMB=$(jq -r '.persona.thumbnailUrl // empty' "$PROFILE")           # character art -> embed thumbnail
PERSONA_ICON=$(jq -r '.persona.iconUrl // .persona.thumbnailUrl // empty' "$PROFILE") # bot icon -> webhook avatar
PERSONA_FOOTER=$(jq -r '.persona.footer // empty' "$PROFILE")
get_webhook_url() {
  local wj guild
  wj=$(aws ssm get-parameter --name "/gatekeeper/${GAME_ID}/active-world" --region "$REGION" --query "Parameter.Value" --output text 2>/dev/null) || return 1
  guild=$(echo "$wj" | jq -r '.discordServerId // empty') || return 1
  [ -z "$guild" ] && return 1
  aws ssm get-parameter --name "/gatekeeper/${GAME_ID}/discord-webhook/${guild}" --with-decryption \
    --region "$REGION" --query "Parameter.Value" --output text 2>/dev/null
}
# Whether a notification category is enabled (SSM /gatekeeper/<game>/notify/<cat>;
# enabled by default when unset). Toggled per-game via `/<cmd> notify`.
notify_enabled() { # $1 = category
  local v
  # `|| true` inside the substitution: a missing param (the default/unset case) makes
  # aws exit non-zero, which would trip this script's `set -e` before the test runs.
  v=$(aws ssm get-parameter --name "/gatekeeper/${GAME_ID}/notify/$1" \
        --region "$REGION" --query 'Parameter.Value' --output text 2>/dev/null || true)
  [ "$v" != "off" ]
}
post_discord() { # $1 = title, $2 = description, $3 = color (decimal)
  local url; url=$(get_webhook_url) || { log "no webhook configured; skipping Discord post"; return 0; }
  { [ -z "$url" ] || [ "$url" = "None" ]; } && { log "no webhook configured; skipping Discord post"; return 0; }
  local payload
  payload=$(jq -n --arg name "$PERSONA_NAME" --arg icon "$PERSONA_ICON" --arg thumb "$PERSONA_THUMB" \
    --arg footer "$PERSONA_FOOTER" \
    --arg title "$1" --arg desc "$2" --argjson color "$3" \
    '{username: $name, embeds: [{title: $title, description: $desc, color: $color}]}
     | if $footer != "" then .embeds[0].footer = {text: $footer} else . end
     | if $thumb != "" then .embeds[0].thumbnail = {url: $thumb} else . end
     | if $icon != "" then .avatar_url = $icon else . end')
  curl -s -m 10 -H "Content-Type: application/json" -X POST "$url" -d "$payload" \
    > /dev/null 2>&1 || log "WARNING: Discord post failed"
}

if [ ! -d "$DATA_HOST" ]; then
  log "ERROR: data volume not found: $DATA_HOST"
  exit 1
fi

TS=$(date +%Y%m%d-%H%M%S)
ARCHIVE="/tmp/${GAME_ID}-${TS}.tar.gz"
log "Archiving $DATA_HOST -> $ARCHIVE"
tar czf "$ARCHIVE" -C "$DATA_HOST" \
  --exclude='./Logs' \
  --exclude='*/CrashReportClient' \
  .

DEST="s3://${BUCKET}/backups/${GAME_ID}/${TS}.tar.gz"
SIZE=$(du -h "$ARCHIVE" | cut -f1)
log "Uploading -> $DEST"
aws s3 cp "$ARCHIVE" "$DEST" --region "$REGION"
rm -f "$ARCHIVE"
log "Backup complete: $DEST"
# `if` (not `&&`) so a silenced category's non-zero exit doesn't trip set -e and
# make this script report a false backup failure to its caller (the monitor).
if notify_enabled backup; then
  post_discord "💾 Backup Complete" "World data archived safely — \`${TS}.tar.gz\` (${SIZE}). Everyone's progress is saved." 3776160
fi
