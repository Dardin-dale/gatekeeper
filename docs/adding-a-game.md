# Adding a game

GATEKeeper runs one game per deployed stack, described entirely by a `GameProfile`. Adding a game is
"write a profile + deploy" — no infra edits. Each game is its own isolated stack
(`GateStack-<Pascal>`), SSM subtree (`/gatekeeper/<game-id>/*`), EBS volume, and cost.

## 1. Write the profile

Copy the scaffold and fill it in:

```bash
cp lib/games/_template.ts lib/games/my-game.ts
```

Key fields (see `lib/games/types.ts` for the full contract):

- `id` — stable kebab-case id (drives stack name, SSM subtree, config filename).
- `container` — `image`, `name`, `staticEnv` (always-on), `envMap` (canonical field → this game's
  env var names), `volumes` (host↔container mounts on `/mnt/game-data`), `savePath`, `defaultArgs`.
- `ports` + `queryPort` — opened on the security group. **`queryPort` is required**: monitoring
  (player count, liveness, idle shutdown) is done via Steam A2S, so the game must expose A2S.
- `instanceType`, `dataVolumeSizeGb` — sizing (override instance with `INSTANCE_TYPE`).
- `join` — `{ type: 'address', port }` for IP/A2S games, or `{ type: 'join-code', logPattern }`.
- `persona` — the bot's voice/branding for this game (drives every embed). No secrets here.

## 2. Register it

In `lib/games/index.ts`, import the profile and add it to `GAME_PROFILES`.

## 3. Validate locally (no AWS)

Mirror the profile in a compose file and confirm the image boots + A2S answers:

```bash
docker compose -f docker-compose.local.yml up        # adapt image/env/ports/volumes to the profile
node scripts/game/a2s-query.js 127.0.0.1 <queryPort>  # expect: LIVE {...}
```

The host start script is generic — if the compose `docker run` works, the EC2 runtime built from the
same profile will too. (See how `abiotic-factor.ts` was de-risked this way.)

## 4. Add world config (gitignored)

```bash
cp config/<existing>.worlds.example.json config/my-game.worlds.json   # then edit
```

`[{ name, worldName, serverPassword, discordServerId, default?, adminIds? }]`. Commit a
`config/my-game.worlds.example.json` template; **never** commit the real `*.worlds.json`.

## 5. Deploy

```bash
source .env && GAME=my-game npm run deploy
```

This produces a fresh `GateStack-<Pascal>` — a clean second stack with no collisions against existing
games. Then set the Discord Interactions Endpoint, `/gate setup`, and `/gate start`.

## A2S-only constraint

Monitoring assumes the server answers Steam A2S on `queryPort`. Almost all Steam dedicated servers
do. A game without A2S would need a different liveness/player-count source (e.g. log scraping, as the
Valheim stub's `join-code`/`logPattern` hints) — not currently implemented in the monitor.
