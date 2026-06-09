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

4. Report the outputs: `InstanceId`, `ApiEndpoint` (set this as the Discord Interactions Endpoint
   URL), `BackupBucketName`, and `CustomDomain` (if `BASE_DOMAIN` is set).

## Notes

- `.env` must be sourced — CDK reads `GAME`, `BASE_DOMAIN`, and the Discord app values at synth.
- The stack name is `GateStack-<Pascal>` (e.g. `GateStack-AbioticFactor`). It is isolated from any
  other game's stack and from the legacy huginbot `ValheimStack`.
- The data EBS volume is RETAIN'd; redeploys that replace the instance keep worlds intact.
- After deploy, scripts + `game-profile.json` are synced to the instance from S3 on first boot.
- First server boot under Wine + SteamCMD is slow (several minutes) — the readiness ping fires when
  A2S first answers.
