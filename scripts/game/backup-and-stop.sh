#!/bin/bash
set -uo pipefail
#
# Backup the active game's saves, then stop the instance. Invoked by /gate stop
# (normal path) via SSM RunShellScript. Game-agnostic: delegates to the generic
# backup-server.sh, then stops the host. The "server offline" Discord message is
# posted by the EC2 state-change notification Lambda once the instance is down.

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') - $1"; }

REGION=$(curl -s --connect-timeout 5 http://169.254.169.254/latest/meta-data/placement/region)
INSTANCE_ID=$(curl -s --connect-timeout 5 http://169.254.169.254/latest/meta-data/instance-id)
[ -z "$REGION" ] || [ -z "$INSTANCE_ID" ] && { log "ERROR: could not read instance metadata"; exit 1; }

log "Backup-and-stop sequence starting"
if /usr/local/bin/backup-server.sh; then
  log "Backup complete"
else
  log "WARNING: backup failed; stopping anyway (data persists on the RETAIN'd EBS volume)"
fi

log "Stopping instance $INSTANCE_ID"
aws ec2 stop-instances --instance-ids "$INSTANCE_ID" --region "$REGION"
