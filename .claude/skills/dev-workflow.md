# /dev-workflow - GATEKeeper Development Workflow

Workflow for making changes to GATEKeeper.

## Key directories

- `lib/games/` — `GameProfile` definitions (the single source of truth per game).
- `lib/valheim/valheim-stack.ts` — CDK stack (parameterized by `ACTIVE_GAME`).
- `lib/lambdas/` — Discord command handlers + notifications.
- `scripts/game/` — game-agnostic bash that runs on EC2 (`start-server`, `monitor`, `backup-server`,
  `backup-and-stop`, `a2s-query.js`).
- `cli/` — the small game-aware CLI (backups).

## Standard loop

1. Edit. 2. `npm run test` (regenerate CDK snapshot with `npm test -- -u` when infra changes
   intentionally). 3. `npm run build`. 4. Deploy.

## Deploy methods

| Change type | Method |
|-------------|--------|
| Lambda / CDK stack / profile | Full deploy: `source .env && npm run deploy` |
| `scripts/game/` only (server running) | Push scripts — see `/push-scripts` |
| CLI code | No deploy needed |

## Validate without AWS

```bash
docker compose -f docker-compose.local.yml up         # boot the real game container
node scripts/game/a2s-query.js 127.0.0.1 27015         # expect LIVE {...}
npm run local-dev                                      # Lambda behind ngrok for live Discord tests
```

## Environment

`source .env` before deploying. Relevant vars: `GAME`, `AWS_REGION`, `BASE_DOMAIN` (optional),
`DISCORD_APP_ID` / `DISCORD_BOT_PUBLIC_KEY` / `DISCORD_BOT_TOKEN`. World secrets are **not** in
`.env` — they live in `config/<game>.worlds.json` (gitignored).
