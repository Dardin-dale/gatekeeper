# Game candidates

Assessment of the next `GameProfile` targets against the plugin contract
(community Docker image · A2S on `queryPort` · file saves on the data volume ·
`address`/`join-code` join · optional `mods` kinds). Researched June 2026; re-verify
the flagged items at implementation time (Tier-2 local Docker test before any deploy).

**Priority: 1) Valheim (full port, retires huginbot), 2) Core Keeper.** Factorio and
Satisfactory are documented for later — both need the monitor's one structural change
(a pluggable query strategy).

## 1. Valheim — full port (currently a stub)

Everything is already proven: the profile stub is faithful, A2S on 2457 works with the
existing monitor, and mods are wired (`bepinex-plugin` kind + Thunderstore import in the CLI).
Remaining work is operational, not architectural:

- [ ] Real `config/valheim.worlds.json` (+ migrate worlds off huginbot via `cli world push`).
- [ ] New Discord app (`config/valheim.discord.json`), register `/munin` commands. The profile is
      personified as **Munin** (memory, the other raven) precisely so command names, persona, and
      embeds never collide with the still-running huginbot during migration.
- [ ] `GAME=valheim npm run deploy` → `GateStack-Valheim` alongside the AF stack.
- [ ] Import the old mod set: `GAME=valheim npm run cli mods import <Author/Mod>` per mod.
- [ ] Verify join-code scrape (`logPattern`) against the current server image's log format.
- [ ] Retire/destroy the huginbot stack once stable (its RETAIN'd EBS keeps the old worlds).

## 2. Core Keeper — fits the contract today

| Contract | Finding |
|---|---|
| Image | `escaping/core-keeper-dedicated` (Linux-native, app 1963720, maintained; built-in mod.io + Discord-webhook support) |
| Monitoring | **A2S at `SERVER_PORT`+1 in direct-connect mode** (gamedig/LinuxGSM both treat it as protocol-valve). ⚠️ Verify post-1.2 with a local A2S smoke test; almost certainly absent in relay mode |
| Join | Set `SERVER_PORT` → direct ip:port (UDP), our standard `address` join. Default (no port) is Game-ID-over-Steam-relay — scrapeable from `GameInfo.txt`/logs if ever wanted, but Steam-relay mode would break A2S monitoring, so **use direct-connect mode** |
| Saves | Single `<index>.world.gzip` + `ServerConfig.json` under one data dir — very backup-friendly |
| Mods | Official SDK mods from [mod.io/g/corekeeper](https://mod.io/g/corekeeper): server loads folders under `CoreKeeperServer_Data/StreamingAssets/Mods/<Mod>/` → one `core-keeper-mod` kind. mod.io has a real REST API (headless import possible later; the image even has it built in). Clients must match manually (`clientsMustMatch: true`) |
| Sizing | ~2 vCPU / 4 GB (t3.medium class); CPU-hungrier than it looks |

Profile sketch: env map from the image (`WORLD_NAME`, `MAX_PLAYERS`, `SERVER_PORT`, ...).
Note: dedicated servers are **Steam clients only** (no PlayFab crossplay) — fine for us.
One contract wrinkle: Core Keeper has no password env — access control is the unguessable
Game ID or network-level; check whether `envMap.password` (currently required) should become
optional, or repurpose it.

## 3. Factorio — easy runtime, needs a query-strategy carve-out

- `factoriotools/factorio` image (Linux-native headless, free binary), single `/factorio` volume,
  join = ip:34197/udp + optional password. Pin `stable`/exact tags, never `latest`.
- **No A2S.** Liveness/player count via **RCON** (27015/tcp, password auto-written into the
  volume): `/players online count`. The monitor needs a `QueryStrategy` abstraction
  (`a2s | rcon | ...`) mirroring `JoinStrategy` — that's the one structural change, and it
  unblocks Satisfactory and Minecraft-class games too.
- Mods: mods.factorio.com has a **real download API** (free account token) → a `factorio-mod`
  kind (zip into `mods/`) + token-based CLI import. Killer feature: **clients auto-sync mods
  from the server on join** — no client-matching problem at all.
- Timing note: Factorio 2.1 (the final breaking update) lands ~mid-2026; mod ecosystem will
  churn around it.

## 4. Satisfactory — workable, most friction

- `wolveix/satisfactory-server` image; heavy (8–16 GB RAM → bigger instance, real cost).
- **No A2S.** HTTPS API on the game port (`POST /api/v1`, self-signed TLS):
  `QueryServerState` returns player count **unauthenticated** — fits the same `QueryStrategy`
  carve-out (an `https` strategy that skips cert verification).
- Join is a two-step in-game Server Manager flow (add ip:7777, claim, optional client password) —
  `address` join with a `hint` covers it.
- Mods (ficsit.app/SML, `ficsit-cli` for headless installs into `FactoryGame/Mods/`): clients
  must match exactly, and **every game update breaks SML + all mods** until re-released; the
  image must run `SKIPUPDATE=true` and update game+SML+mods as one deliberate operation, while
  Steam clients auto-update past you. The worst mod-update story of the four — run it vanilla
  first if at all.

## Optional password (prereq for Core Keeper)

Core Keeper has no password env — access control is the unguessable Game ID / network level.
The contract currently makes a password mandatory in two places; the change is small:

1. `EnvMap.password` becomes optional (`password?: string`) — `add_env` in `start-server.sh`
   already skips unmapped fields, and the CDK doesn't touch it.
2. `validateWorldConfig` drops its unconditional password requirement: require it **iff the
   active profile maps one** — e.g. `validateWorldConfig(config, { requirePassword })` with
   callers passing `Boolean(ACTIVE_GAME.container.envMap.password)`. Tests cover both modes.
3. `/gate join` / the readiness embed render the password field only when the world has one
   (`util/join-info` — likely already conditional; verify).

## The QueryStrategy carve-out (prereq for 3 & 4)

`queryPort`/A2S is the contract's hard assumption (`docs/adding-a-game.md`). Plan when needed:

```ts
query: { type: 'a2s'; port: number }                       // today's behavior (default)
     | { type: 'rcon'; port: number; passwordFile: string } // Factorio
     | { type: 'https'; port: number; path: string }        // Satisfactory (insecure TLS)
```

`monitor.sh` already shells out to `a2s-query.js`; each strategy is just a different tiny
query helper emitting the same `LIVE/DEAD + players` line, selected from the runtime profile.
Valheim and Core Keeper don't need it — don't build it until Factorio/Satisfactory/Minecraft
is actually next.
