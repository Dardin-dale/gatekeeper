# /add-game - Add a new game to GATEKeeper

Add a game as a `GameProfile` plugin: research → profile → local validation → config → deploy.
Adding a game must never require infra edits — if it does, the contract needs a carve-out (see
"When the game doesn't fit" below) and that's a separate, deliberate change.

References: `docs/adding-a-game.md` (checklist), `docs/GAME-CANDIDATES.md` (researched games +
queued contract changes), `docs/mods.md` (mod kinds), `lib/games/types.ts` (the contract).

## 0. Research first (don't write code yet)

Answer ALL of these before touching the profile — web search + the game's hosting guides.
`docs/GAME-CANDIDATES.md` may already have the answers (Core Keeper, Factorio, Satisfactory);
update/extend that doc with what you learn either way.

1. **Image** — is there a maintained community Docker image? (Prefer the one hosting guides
   converge on.) Linux-native or Wine? Its env vars, volumes, ports, save paths.
2. **Monitoring** — does the dedicated server answer **Steam A2S**, on which port? (Check
   node-gamedig's GAMES_LIST `protocol: 'valve'` entry and LinuxGSM's `querytype` for the game.)
   No A2S → blocked on the `QueryStrategy` carve-out (GAME-CANDIDATES.md sketches it).
3. **Join** — direct `ip:port` (→ `address`) or a code printed in logs (→ `join-code` with an ERE
   `logPattern`)? Password env? A game with **no password mechanism** needs the optional-password
   contract change (GAME-CANDIDATES.md).
4. **Saves** — where do world files live? Must be bind-mountable to `/mnt/game-data/...`.
5. **Mods** (optional) — where do mods live (Thunderstore? Nexus? mod.io?), how do they install on
   a *dedicated server* (paths/format → the `kinds` map), must clients match?
6. **Sizing** — RAM/CPU expectations → `instanceType`, download size → `dataVolumeSizeGb`.

## 1. Write the profile

```bash
cp lib/games/_template.ts lib/games/<id>.ts   # fill every TODO
```

Gotchas learned the hard way:
- **`commandName` must not collide** with any other bot in your guilds (incl. legacy huginbot) —
  it's the only Discord-visible namespace. Persona = the bot's whole identity; pick a distinct
  character, not a reskin.
- `staticEnv` is for always-on image settings (e.g. `AutoUpdate`); per-world strings flow through
  `envMap` from the worlds config. **No secrets in the profile, ever.**
- Every `mods.kinds[*].targetPath` must sit under a declared volume `hostPath` (a unit test
  enforces this — run `npm test` early).
- Register in `lib/games/index.ts` (`GAME_PROFILES`), then `npm run build && npm test`.

## 2. Validate locally (Tier 2 — REQUIRED, no AWS)

Mirror the profile in `docker-compose.local.yml` (image/env/ports/volumes) and prove on real
hardware:

```bash
docker compose -f docker-compose.local.yml up
node scripts/game/a2s-query.js 127.0.0.1 <queryPort>   # expect: LIVE {...}
```

- A2S answers with the right game name + player count (this is what monitoring/auto-shutdown rely
  on — do not skip even if "the wiki says" it works).
- The save appears at `savePath` under the data volume; restart loads the same world.
- `join-code` games: confirm the `logPattern` ERE matches the *current* image's log line.
- If the game has mods: install one real mod by hand the way the `kind` would and confirm it loads.

## 3. Config (gitignored) + Discord app

```bash
cp config/<existing>.worlds.example.json config/<id>.worlds.json   # real worlds, real passwords
# Also COMMIT a config/<id>.worlds.example.json with placeholders only.
```

Create a **new** Discord application (never reuse another game's): App ID / Public Key / Bot Token
→ `config/<id>.discord.json`. Worlds shape:
`[{ name, worldName, serverPassword, discordServerId, default?, adminIds?, extraArgs?, mods? }]`.

## 4. Deploy + wire up

```bash
source .env && GAME=<id> npm run deploy        # fresh GateStack-<Pascal>, zero collisions
GAME=<id> npm run register-commands            # registers /<commandName> (global: up to ~1 hr)
```

Then follow `.claude/skills/deploy.md` post-deploy: Interactions Endpoint URL
(`<ApiEndpoint>interactions/control`), invite the bot, `/<cmd> hail` → `/<cmd> setup` →
`/<cmd> start`. New stacks do NOT need a `DeploymentVersion` bump (that's only for
instance-replacing changes to an *existing* stack).

Seed existing worlds with `GAME=<id> npm run cli world push/restore`; import mods with
`GAME=<id> npm run cli mods add|import`.

## 5. Close the loop

- Tick the game off / correct findings in `docs/GAME-CANDIDATES.md`.
- Add the game to the README's multi-game examples if it's a real deployment.
- New runtime facts (image quirks, required args, log formats) → a "Verified specs" note in
  `docs/DEVELOPMENT-PLAN.md`, like AF's.

## When the game doesn't fit the contract

Stop and design the carve-out as its own change (pattern: a tagged union like `JoinStrategy`,
consumed generically by CDK/bash/lambdas — never an if-game-X branch):
- **No A2S** → `QueryStrategy` (`a2s | rcon | https`) — sketched in GAME-CANDIDATES.md
  (Factorio needs `rcon`, Satisfactory `https`).
- **No password env** → make `EnvMap.password` optional + world validation conditional on the
  profile (Core Keeper needs this).
- Anything else: the profile stays pure JSON-serializable data — if a game seems to need code,
  it actually needs a new declarative field.
