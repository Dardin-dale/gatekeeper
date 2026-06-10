# Mods

GATEKeeper's mod support is **profile-driven and per-world**, mirroring the config split used
everywhere else:

- **HOW a game takes mods** (committed): `GameProfile.mods` — the install *kinds* the game accepts
  and where each kind's files land on the host (`lib/games/types.ts: ModsSpec`).
- **WHICH mods exist** (S3): the **mod library** in the game's backup bucket —
  `s3://<bucket>/mods/<Name>/{metadata.json, files/...}`, managed by `npm run cli mods ...`.
- **WHAT a world runs** (gitignored): the `mods` array on a world in `config/<game>.worlds.json`,
  naming library entries.

```
GameProfile.mods.kinds        config/<game>.worlds.json         S3 mod library
  pak -> .../Content/Paks  +    "mods": ["BetterDeploys"]   +     mods/BetterDeploys/...
                 └────────────────── start-server.sh ──────────────────┘
                      installs on world start, manifest-tracked
```

## How installs work (host runtime)

On every server start, `scripts/game/start-server.sh`:

1. Removes the files listed in `/mnt/game-data/.gatekeeper/mods.manifest` — exactly the files the
   previous start installed, never anything else (AF paks share `Content/Paks/` with base-game
   files, so wholesale wipes are off the table).
2. For each name in the active world's `mods`: reads the library `metadata.json`, resolves its
   `kind` against the profile's `modKinds`, copies `files/` into that kind's `targetPath`, and
   records every path in the manifest.
3. Adds the kind's container env when at least one mod of that kind installed (e.g. Valheim's
   `BEPINEX=true`).

Unknown mods, unknown kinds, and library misses are warned and **skipped** — a bad mod entry never
blocks the server from starting. Switching to a vanilla world uninstalls everything (step 1).

Worlds config is baked into the Lambda at synth, so changing a world's `mods` is:
edit `config/<game>.worlds.json` → `npm run deploy` (Lambda env update, fast) → `/gate stop` +
`/gate start`.

## The library CLI

```bash
npm run cli mods list                      # what's in the library
npm run cli mods add <file|dir|zip> [name] # ingest a mod you downloaded (--kind, --url, --version)
npm run cli mods import <Ns/Mod[@ver]>     # Thunderstore games only (e.g. GAME=valheim)
npm run cli mods info <name>               # metadata + file list
npm run cli mods remove <name>             # delete from the library
```

Mod names key S3 paths and host file paths: letters/digits/`._-` only.

## Discord

- `/gate mods [world]` — a world's mod list with portal links. For games flagged
  `clientsMustMatch` it carries the warning that players must install the same mods locally —
  the command doubles as the client install list.
- `/gate worlds` — the worlds a guild can start (with a 🧩 mod count), so `/gate start <world>`
  has discoverable arguments.

## Per-game notes

### Abiotic Factor (`kind: pak`, source: manual/Nexus)

AF mods live on [Nexus Mods](https://www.nexusmods.com/games/abioticfactor) — there is no
Thunderstore community, Steam Workshop, or headless download API — so ingestion is manual:

```bash
# 1. Download the mod zip from Nexus yourself, then:
npm run cli mods add ~/Downloads/BetterDeploys-12-1-0.zip BetterDeploys \
  --url=https://www.nexusmods.com/abioticfactor/mods/12 --version=1.0
# 2. Add "BetterDeploys" to the world's "mods" in config/abiotic-factor.worlds.json
# 3. npm run deploy, then /gate stop + /gate start
```

Only **pak patch mods** are supported (`*_P.pak`/`.utoc`/`.ucas` files; they install next to the
base pakchunks under `gamefiles/AbioticFactor/Content/Paks`). **UE4SS script mods are deliberately
unsupported**: they need a community-pinned loader DLL that is currently broken under Wine
(post-v1.3.0), plus `WINEDLLOVERRIDES` plumbing. Revisit if the ecosystem stabilizes — it would be
a second `kind` on the profile, no infra change.

Caveats:
- **Clients must match.** AF has no server→client mod sync; players install the same paks by hand
  (`/gate mods` is the checklist). Server-side-only mods exist but are the minority — check each
  mod's Nexus page.
- **Updates.** `AutoUpdate=true` keeps the server current (required for vanilla clients to join),
  so a game update can silently stale a pak mod. Pak `_P` patches tolerate updates better than
  script mods, but after a big patch, re-check your mods.

### Valheim (`kind: bepinex-plugin`, source: Thunderstore)

The huginbot model: plugin `.dll`s sync into `config/bepinex/plugins` and the container installs
BepInEx itself when any are present (`BEPINEX=true` kind env). `cli mods import Author/Mod` pulls
straight from Thunderstore (latest or `@version`), records declared dependencies in the metadata,
and prints them as a reminder — dependencies are **not** auto-imported.

## Adding mod support to a new game

Declare the kinds in the profile (see `_template.ts`): each kind maps a metadata `kind` string to
a host `targetPath` that **must live under one of the profile's volume mounts** (enforced by a unit
test — anywhere else, mods would vanish on instance replacement). Add `source` for CLI ergonomics
and `clientsMustMatch` if the game has no client sync. The host installer, CLI, and `/gate mods`
all pick it up with zero further changes.
