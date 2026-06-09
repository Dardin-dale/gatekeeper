# /deploy - Deploy GATEKeeper to AWS

Deploy the GATEKeeper stack for the active game (`GAME`, default `abiotic-factor`).

## Steps

1. Run tests:
   ```bash
   npm run test
   ```
2. Build:
   ```bash
   npm run build
   ```
3. Deploy (sources `.env` for Discord/AWS env; `--all` deploys the single game stack):
   ```bash
   source .env && npm run deploy
   ```
   To target a different game: `source .env && GAME=valheim npm run deploy`.

4. Report the outputs: `InstanceId`, `ApiEndpoint`, `BackupBucketName`, and `CustomDomain` (if
   `BASE_DOMAIN` is set).

## Post-deploy: wire Discord (commands don't work until ALL of these are done)

1. **Interactions Endpoint URL** — in the Developer Portal (General Information), set it to the
   `ApiEndpoint` output **plus `interactions/control`**:
   `https://<api-id>.execute-api.<region>.amazonaws.com/prod/interactions/control`
   Discord PING-validates on save; a green save means the Lambda verified the signature.
2. **Register commands:** `npm run register-commands` (global commands can take up to ~1 hr to appear).
3. **Invite the bot** (once per server): the invite URL is printed by `register-commands`
   (scopes `bot applications.commands`, permissions `536873984` = View Channels + Send Messages +
   Manage Webhooks).
4. **In Discord:** `/gate hail` (works with no server) → `/gate setup` in the notifications channel.

### Troubleshooting "The application did not respond"

- **Zero invocations in the commands Lambda's CloudWatch logs** → Discord is not calling us at all:
  the Interactions Endpoint URL was never saved, or lacks the `/interactions/control` path.
- Probe the route directly: `curl -X POST <ApiEndpoint>interactions/control -H 'Content-Type:
  application/json' -d '{"type":1}'` — a `401 {"error":"Unauthorized"}` means API Gateway → Lambda →
  signature check are all healthy (unsigned requests are *supposed* to 401).
- **Portal refuses to save the URL** → public-key mismatch: the app's Public Key must equal the
  deploy-time `DISCORD_BOT_PUBLIC_KEY` (`.env` or `config/<game>.discord.json`). Fix and redeploy.
- Lambda logs live at `/aws/lambda/<stack>-CommandsFunction...` (find the name via
  `aws cloudformation describe-stack-resources --stack-name GateStack-<Game>`).

## Notes

- `.env` must be sourced — CDK reads `GAME`, `BASE_DOMAIN`, and the Discord app values at synth.
- The stack name is `GateStack-<Pascal>` (e.g. `GateStack-AbioticFactor`). It is isolated from any
  other game's stack and from the legacy huginbot `ValheimStack`.
- The data EBS volume is RETAIN'd; redeploys that replace the instance keep worlds intact.
- After deploy, scripts + `game-profile.json` are synced to the instance from S3 on first boot.
- First server boot under Wine + SteamCMD is slow (several minutes) — the readiness ping fires when
  A2S first answers.
