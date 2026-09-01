# GATEKeeper — Development Guide

GATEKeeper is a cost-effective, **multi-game** AWS server manager controlled from Discord, built
on a `GameProfile` abstraction. Two games are deployed: **Abiotic Factor** (`/gate`) and
**Valheim** (`/munin`). Adapted from
[huginbot](https://github.com/Dardin-dale/huginbot) (a Valheim-only predecessor).

The roadmap and phase history live in `docs/DEVELOPMENT-PLAN.md`. Read that for context.

## The core idea: one `GameProfile`, three consumers

A game is described once by a `GameProfile` (`lib/games/<game>.ts`). That single object feeds three
layers, so adding a game is "write a profile + deploy", not "edit the infra":

1. **CDK (build time)** — ports, instance type, data volume, image, save path (`lib/server/game-server-stack.ts`).
2. **Host bash (runtime)** — the runtime-relevant subset is emitted to `game-profile.json` and read
   with `jq` by the EC2 scripts (`scripts/game/*.sh`). See `runtimeProfile()` in `lib/games/index.ts`.
3. **Discord lambdas** — `persona` (embeds, voice) themes every bot message (`lib/lambdas/commands/util/persona.ts`).

Select the active game with the `GAME` env var (default `abiotic-factor`). It drives the stack name
(`GateStack-<Pascal>`), the SSM subtree (`/gatekeeper/<game-id>/*`), and the config filename.

```
lib/games/
  types.ts            GameProfile interface (the plugin contract)
  index.ts            registry, ACTIVE_GAME, runtimeProfile(), gameDomain()
  abiotic-factor.ts   the live profile (image, env map, volumes, ports, persona)
  valheim.ts          the second live profile (join-code game, crossplay/A2S-silent)
  _template.ts        copy-me scaffold for a new game
```

## Architecture

- **EC2 + Docker** runs the game server. The data volume is a separate **RETAIN'd EBS volume**, so
  worlds survive instance replacement and stop/start.
- ⚠️ **Instance-replacing changes (AMI, instance type, user-data) MUST bump `DeploymentVersion`**
  (two spots in `game-server-stack.ts`: the VolumeDetachResource property + the instance tag).
  The volume-detach custom resource only runs when that property changes — without the bump,
  CFN tries to attach the still-attached data volume to the new instance and the deploy
  fails/rolls back with "volume already attached".
- **Profile-driven runtime**: `game-server.service` → `scripts/game/start-server.sh` reads
  `game-profile.json` + the active world from SSM and issues the `docker run`. `game-monitor.service`
  → `scripts/game/monitor.sh` queries **Steam A2S on localhost** for player count + liveness, writes
  the count to SSM/CloudWatch, posts a readiness ping, and stops the instance when idle.
  ⚠️ Crossplay Valheim is **A2S-silent** (PlayFab) — the monitor falls back to the profile's
  `playersLogPattern` log heartbeat for liveness + player count.
- **Presence sidecar**: `game-presence.service` → `scripts/game/presence.js` holds a Discord
  gateway connection so the bot shows ONLINE ("Playing <game> (N online)") while the server runs
  (`PartOf game-server.service`). Bot token seeded once per game: `npm run cli discord put-token`.
- **Scripts ship via S3**, not baked into an AMI: `update-gatekeeper-scripts.service` syncs
  `scripts/game/` (+ `game-profile.json`) from the backup bucket on boot.
- **Discord HTTP interactions** hit API Gateway → the commands Lambda (Ed25519-verified). One
  top-level `/gate` command with subcommands.
- **Notifications**: the host posts readiness/idle/backup messages directly to the guild webhook;
  one Lambda (`discord-notifications.ts`) posts the final "server offline" on the EC2-stopped event.
- **Status message**: ONE durable message per guild, created and **pinned** once
  (`pinned-status/<guild-id>` in SSM) then edited in place across sessions — Starting → Online →
  Winding down → Offline. Webhooks can't pin, so the pin call uses the bot token; a missing
  `Manage Messages` degrades to unpinned, never to broken. The per-session TTL delete skips it.
- **Boot visibility**: `GameProfile.bootPhases` name the pre-live stages (updating / verifying /
  loading / **failed**) scraped from container logs, published to SSM `boot-phase` and rendered by
  `/<cmd> status` + the status message. A `failure: true` phase wins over any later phase — a
  server whose update failed keeps logging later stages while being unjoinable.
- **Domain (optional)**: set `BASE_DOMAIN` → each game gets `<subdomain>.<BASE_DOMAIN>` (e.g.
  `abiotic.gjurdsihop.net`) in one shared Route 53 zone, updated to the instance IP on start.

## Commands

| Task | Command |
|------|---------|
| Build | `npm run build` |
| Test | `npm run test` (update CDK snapshot: `npm test -- -u`) |
| Synth | `GAME=abiotic-factor npm run cdk synth GateStack-AbioticFactor` |
| Deploy | `source .env && npm run deploy` (`cdk deploy --all`) |
| CLI | `npm run cli` (see `docs/cli.md`) |
| Register slash commands | `npm run register-commands` |
| Bot install / permission URL | `npm run cli discord invite-url` |
| Local AF container | `docker compose -f docker-compose.local.yml up` |
| Local Valheim container (vanilla) | `docker compose -f docker-compose.valheim.local.yml up` (`VH_ARGS=-crossplay` for PlayFab) |
| Local A2S check | `node scripts/game/a2s-query.js 127.0.0.1 27015` |

## Discord commands (`/gate <sub>`)

`hail` (persona ping) · `start [world] [private]` · `stop [force]` · `status` · `backup`
(archive without stopping) · `join` · `open` · `worlds` · `mods [world]` ·
`schedule set|clear|list` · `notify set|list` (toggle host→Discord posts, SSM
`/gatekeeper/<game>/notify/<category>`) · `config show|set` (owner-only spend timers, gated by
`BOT_OWNER_IDS`) · `setup` · `help`.
Dispatch lives in `lib/lambdas/commands.ts`; each subcommand is a handler in `lib/lambdas/commands/`.

**Private (quiet) sessions**: `start private:True` sets SSM `session-private=true` (per-start, so a
normal start resets it) and DMs the owner(s) a heads-up (cost/oversight; skips the caller). The host
monitor then skips the public "Server Online" broadcast, and `join`/`status` reply ephemerally
(auto-following the session), each marked 🔒. `open` flips the flag off and announces the join
details to the channel — posting the embed itself if the game is already live (the host's ping was
skipped), or letting the host's normal readiness ping fire if it's still booting.
Scheduled openings use EventBridge Scheduler (one-time schedules in a per-game group) firing
`lib/lambdas/scheduler.ts`, which pre-warms the instance `prewarm-minutes` (SSM, default 10)
before the announced time and posts T-60/T-10 countdown webhooks. Input times parse in
`SCHEDULE_TZ` (env, default America/Los_Angeles); display is Discord-native timestamps.

## Config & secrets

- **How to run a game** (committed, no secrets): the `GameProfile`.
- **What to run** (gitignored secrets): `config/<game>.worlds.json` — `[{ name, worldName,
  serverPassword, discordServerId, default?, adminIds?, mods? }]`. A committed
  `*.worlds.example.json` is the template. The stack reads it into the `WORLDS_JSON` Lambda env at synth.
- **Mods** (see `docs/mods.md`): per-game install kinds on `GameProfile.mods`; the library lives at
  `s3://<backup-bucket>/mods/<Name>/` (`cli mods ...`); a world's `mods` array names library entries,
  installed by the host on world start (manifest-tracked).
- **Runtime source of truth**: SSM under `/gatekeeper/<game-id>/*` (active world, player count,
  webhooks as SecureString, auto-shutdown minutes, per-guild default world).
- **Cost-guardrail timers** (`auto-shutdown-minutes`, `boot-timeout-minutes`): deploy-time default
  from the `GameProfile` (`autoShutdownMinutes` / `bootTimeoutMinutes`), overridable at deploy via
  the `AUTO_SHUTDOWN_MINUTES` / `BOOT_TIMEOUT_MINUTES` env vars, and retunable live (no redeploy)
  with `npm run cli config set <auto-shutdown|boot-timeout> <min|off>` — the monitor re-reads SSM
  each cycle. A deploy only re-asserts these when the profile/env default changes, so a CLI override
  survives ordinary deploys.
- `/gate start` resolves the per-guild default world → writes `active-world` to SSM → the host start
  script reads it.

**Never commit**: `.env` (Discord tokens), `config/*.worlds.json` (passwords/guild IDs). Both are
gitignored. Pushing to the GitHub remote is a deliberate, user-driven step.

## Testing tiers

1. **Unit (Jest)** — dispatch, profile registry, world config, A2S parse, notifications. No AWS.
2. **Local Docker** — `docker-compose.local.yml` + `a2s-query.js`. Validates the real runtime, no AWS spend.
3. **ngrok** — `npm run local-dev` behind a tunnel for real Discord interactions without deploying.
4. **Deploy** — the isolated `GateStack-<Game>`.

## Adding a game

See `docs/adding-a-game.md`. In short: copy `lib/games/_template.ts`, fill it in, register it in
`lib/games/index.ts`, add `config/<game>.worlds.json`, and `GAME=<id> npm run deploy`.

## Code style

TypeScript strict; `camelCase` vars, `PascalCase` types; return types on exported functions; prefer
`async/await`; AWS clients mocked in tests (never hit real AWS). CDK tests are snapshot-based —
regenerate intentionally with `npm test -- -u`.
