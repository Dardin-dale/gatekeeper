#!/bin/bash
set -uo pipefail
#
# Backup the active game's saves, then stop the instance. Invoked by /gate stop
# (normal path) via SSM RunShellScript. Game-agnostic: delegates to the generic
# backup-server.sh, then stops the host. The "server offline" Discord message is
# posted by the EC2 state-change notification Lambda once the instance is down.

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') - $1"; }

# IMDSv2-aware metadata fetch (AL2023 enforces token auth; works on optional too).
imds() {
  local t
  t=$(curl -s -m 5 -X PUT http://169.254.169.254/latest/api/token \
        -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
  curl -s -m 5 -H "X-aws-ec2-metadata-token: $t" \
        "http://169.254.169.254/latest/meta-data/$1"
}

REGION=$(imds placement/region)
INSTANCE_ID=$(imds instance-id)
[ -z "$REGION" ] || [ -z "$INSTANCE_ID" ] && { log "ERROR: could not read instance metadata"; exit 1; }

log "Backup-and-stop sequence starting"
if /usr/local/bin/backup-server.sh --shutdown; then
  log "Backup complete"
else
  log "WARNING: backup failed; stopping anyway (data persists on the RETAIN'd EBS volume)"
fi

# Invalidate the per-session join code + live flag so /gate join|status never
# show this session's dead lobby code after the stop. (The notifications Lambda
# clears these too, as the catch-all for stops that bypass this script.)
GAME_ID=$(jq -r '.id' /etc/gatekeeper/game-profile.json 2>/dev/null)
if [ -n "$GAME_ID" ]; then
  aws ssm put-parameter --name "/gatekeeper/${GAME_ID}/join-code" --type String \
    --value "none" --overwrite --region "$REGION" > /dev/null 2>&1
  aws ssm put-parameter --name "/gatekeeper/${GAME_ID}/server-live" --type String \
    --value "false" --overwrite --region "$REGION" > /dev/null 2>&1
fi

log "Stopping instance $INSTANCE_ID"
aws ec2 stop-instances --instance-ids "$INSTANCE_ID" --region "$REGION"
