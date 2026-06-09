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

[ -f "$CONF" ] && source "$CONF"
REGION=$(curl -s --connect-timeout 5 http://169.254.169.254/latest/meta-data/placement/region)
BUCKET="${GATEKEEPER_BUCKET:-}"
[ -z "$BUCKET" ] && { log "ERROR: GATEKEEPER_BUCKET not set"; exit 1; }

GAME_ID=$(jq -r '.id' "$PROFILE")
DATA_HOST=$(jq -r '.volumes[-1].hostPath' "$PROFILE")

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
log "Uploading -> $DEST"
aws s3 cp "$ARCHIVE" "$DEST" --region "$REGION"
rm -f "$ARCHIVE"
log "Backup complete: $DEST"
