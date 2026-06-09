# /server-logs - Check Server Logs and Status

Inspect the running EC2 instance for the active game.

## Steps

1. Get the instance ID + public IP:
   ```bash
   INSTANCE_ID=$(aws cloudformation describe-stacks --stack-name GateStack-AbioticFactor \
     --query 'Stacks[0].Outputs[?OutputKey==`InstanceId`].OutputValue' --output text)
   aws ec2 describe-instances --instance-ids "$INSTANCE_ID" \
     --query 'Reservations[0].Instances[0].[State.Name,PublicIpAddress]' --output text
   ```
2. Container logs via SSM (container name comes from the deployed profile):
   ```bash
   aws ssm send-command --instance-ids "$INSTANCE_ID" --document-name "AWS-RunShellScript" \
     --parameters 'commands=["docker logs $(jq -r .containerName /etc/gatekeeper/game-profile.json) --tail 80"]' \
     --query 'Command.CommandId' --output text
   ```
3. Fetch the output (replace COMMAND_ID):
   ```bash
   sleep 5 && aws ssm get-command-invocation --command-id "COMMAND_ID" --instance-id "$INSTANCE_ID" \
     --query 'StandardOutputContent' --output text
   ```

## Useful checks (via SSM RunShellScript)

- Start/monitor service logs: `journalctl -u game-server.service -n 80` /
  `journalctl -u game-monitor.service -n 80`
- A2S from the host: `node /usr/local/bin/a2s-query.js 127.0.0.1 $(jq -r .queryPort /etc/gatekeeper/game-profile.json)`
- The emitted profile: `cat /etc/gatekeeper/game-profile.json`
- Player count (SSM): `aws ssm get-parameter --name /gatekeeper/abiotic-factor/player-count --query Parameter.Value --output text`

## Quick status

`/gate status` in Discord shows state, world, players, and the join address.
