#!/bin/bash
set -euo pipefail
#
# Game-agnostic world restore: download an archive from the GATEKeeper bucket
# and extract it into the game's persistent data volume. The archive format is
# the one backup-server.sh produces (the data volume tarred from its root), so
# this serves both flows:
#   - restoring a backup            (backups/<game-id>/<timestamp>.tar.gz)
#   - bootstrapping a seeded world  (bootstrap/<game-id>/<name>.tar.gz, pushed
#     by `npm run cli world push`)
#
# Usage: restore-world.sh <s3-key>     (key within the GATEKeeper bucket)
#
# The game is stopped during extraction and restarted after. The current data
# volume is backed up first (best-effort) so a bad restore is recoverable.

PROFILE=/etc/gatekeeper/game-profile.json
CONF=/etc/gatekeeper.conf

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') - $1"; }

KEY="${1:-}"
if [ -z "$KEY" ]; then
  echo "Usage: restore-world.sh <s3-key>  (e.g. bootstrap/abiotic-factor/seed.tar.gz)"
  exit 1
fi

[ -f "$CONF" ] && source "$CONF"
REGION=$(curl -s --connect-timeout 5 http://169.254.169.254/latest/meta-data/placement/region)
BUCKET="${GATEKEEPER_BUCKET:-}"
[ -z "$BUCKET" ] && { log "ERROR: GATEKEEPER_BUCKET not set"; exit 1; }
[ -f "$PROFILE" ] || { log "ERROR: game profile not found: $PROFILE"; exit 1; }

GAME_ID=$(jq -r '.id' "$PROFILE")
DATA_HOST=$(jq -r '.volumes[-1].hostPath' "$PROFILE")

log "Restoring s3://${BUCKET}/${KEY} -> ${DATA_HOST} (${GAME_ID})"

# Download first — don't take the server down for an archive that isn't there.
TMP="/tmp/gk-restore-$$.tar.gz"
trap 'rm -f "$TMP"' EXIT
aws s3 cp "s3://${BUCKET}/${KEY}" "$TMP" --region "$REGION"

# Stop the game so nothing writes to the saves during extraction.
log "Stopping game server for restore"
systemctl stop game-server.service || true

# Safety net: archive the current data before overwriting (best-effort; skip
# when the volume is empty, e.g. a brand-new deploy being seeded).
if [ -d "$DATA_HOST" ] && [ -n "$(ls -A "$DATA_HOST" 2>/dev/null)" ]; then
  log "Backing up current data before restore"
  /usr/local/bin/backup-server.sh || log "WARNING: pre-restore backup failed; continuing"
fi

mkdir -p "$DATA_HOST"
log "Extracting archive"
tar xzf "$TMP" -C "$DATA_HOST"

log "Restarting game server"
systemctl start game-server.service
log "Restore complete: s3://${BUCKET}/${KEY} -> ${DATA_HOST}"
