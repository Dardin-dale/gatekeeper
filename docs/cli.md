# GATEKeeper CLI

A small, **game-aware** companion to the Discord bot. Server control (start/stop/status) lives in
Discord (`/gate ...`); the CLI covers the out-of-band bits — pulling saves down for safekeeping and
triggering backups. It discovers the deployed bucket/instance from the stack's CloudFormation outputs,
so there's nothing to configure beyond your AWS credentials.

## Selecting the game

Everything keys off `GAME` (default `abiotic-factor`), mirroring the CDK stack-name derivation
(`GateStack-<Pascal>`). To target a different game's stack:

```bash
GAME=valheim npm run cli backup list
```

## Commands

```bash
npm run cli                                  # usage
npm run cli backup list                      # list S3 backups for the active game
npm run cli backup pull [name|latest]        # download a backup to ./local/backups/<game-id>
npm run cli backup create                    # trigger a backup on the running server
npm run cli backup restore [name|latest]     # restore a backup onto the running server

npm run cli world add <name> --password=<pw> # add a world to config/<game>.worlds.json (local)
npm run cli world switch [name]              # set/show a guild's default world (what a bare /<cmd> start loads)
npm run cli world push <dir|tar.gz|name>     # upload a local save as a seed archive
npm run cli world pull [name|latest]         # download a seed archive to ./local/seeds/<game-id>
npm run cli world list                       # list uploaded seed archives
npm run cli world restore [name|latest]      # restore a seed archive onto the running server

npm run cli mods list                        # list the S3 mod library
npm run cli mods add <file|dir|zip> [name]   # add a downloaded mod (--kind k --url u --version v)
npm run cli mods import <Ns/Mod[@ver]>       # import from Thunderstore (games with a community)
npm run cli mods info <name>                 # a mod's metadata + files
npm run cli mods remove <name>               # remove a mod from the library

npm run cli config show                      # show runtime tunables (idle/boot timers)
npm run cli config set auto-shutdown <min>   # retune the idle auto-shutdown window live
npm run cli config set boot-timeout <min>    # retune the boot-timeout safety net live
npm run cli config reconstruct [--env]       # rebuild gitignored config/ (+ .env) from the live deploy
```

- **`backup list`** — backups live at `s3://<backup-bucket>/backups/<game-id>/<timestamp>.tar.gz`
  (written by `scripts/game/backup-server.sh`, which archives the whole data/saves volume). The
  newest `BACKUPS_TO_KEEP` per game are kept; older ones rotate out daily.
- **`world add`** — append a world to the gitignored `config/<game>.worlds.json` instead of hand-editing.
  Flags: `--password=<pw>` (required), `--guild=<discordServerId>` (inferred when the roster already
  uses exactly one), `--world=<save>` (on-disk save name; defaults to an ASCII-folded/transliterated
  form of `<name>`, e.g. `Emmumóðir`→`Emmumodir`), `--default`, `--admins="id1 id2"`,
  `--args="<launch args>"`, `--mods=A,B`. Validates like the deploy-time gate and rejects duplicate
  names/save-names. **Local only** — the roster is baked into the Lambda `WORLDS_JSON` at synth, so a
  new world goes live on the next `npm run deploy`; it never touches the running server.
- **`backup pull` / `world pull`** — download to `./local/backups/<game-id>/` and
  `./local/seeds/<game-id>/` respectively. `latest` (default) grabs the newest; or pass a
  filename from the matching `list` command.
- **`backup create`** — runs `backup-server.sh` on the instance via SSM. The server must be running.
- **`backup restore` / `world restore`** — runs `restore-world.sh` on the instance via SSM (server
  must be running): stops the game, **backs up the current data first**, extracts the archive into
  the data volume, and restarts the game (the readiness ping posts to Discord when it's back).
- **`mods ...`** — manages the library at `s3://<backup-bucket>/mods/<Name>/`; worlds opt in via
  their `mods` array in `config/<game>.worlds.json`, installed by the host on world start. The full
  model + per-game walkthroughs (Abiotic Factor/Nexus, Valheim/Thunderstore): `docs/mods.md`.
  `mods add` zip handling shells out to `unzip` (install it locally if missing).
- **`world switch [name]`** — set (or, with no name, show) a guild's **default** world: the SSM param
  (`/gatekeeper/<game>/discord/<guild>/default-world`) that a bare `/<cmd> start` resolves, also shown
  with a ▶️ by `/<cmd> worlds`. Infers `--guild` when the roster uses exactly one (else pass it);
  validates the world belongs to that guild. This is **durable config**, not the live `active-world`
  that `/start` rewrites — so it never restarts or disturbs a running session; it applies on the next
  start. `--dry` previews the change without writing. It's the only writer of this param.
- **`config show` / `config set`** — the two cost-guardrail timers the on-host monitor reads from
  SSM each cycle: `auto-shutdown` (idle minutes before backup+stop) and `boot-timeout` (minutes to
  wait for first liveness before stopping a wedged boot). Their deploy-time default is the
  `GameProfile` (`autoShutdownMinutes` / `bootTimeoutMinutes`), overridable at deploy via the
  `AUTO_SHUTDOWN_MINUTES` / `BOOT_TIMEOUT_MINUTES` env vars. `config set <key> <min|off>` retunes the
  SSM param live — no redeploy, no restart; the monitor picks it up within ~one cycle. A subsequent
  deploy only re-asserts the value when the profile/env default itself changes, so a CLI override
  survives ordinary deploys. Pass `off` (or `disabled`) to turn a guard off.
- **`config reconstruct`** — the recovery path for a fresh machine that never got a copy of the
  gitignored config. Reads the **deployed CloudFormation template** (one read-only `GetTemplate`) and
  rebuilds `config/<game>.worlds.json` and `config/<game>.discord.json` from the Lambda env baked into
  it; `--env` also rebuilds the shared `.env` (`BASE_DOMAIN`, `BOT_OWNER_IDS`, `SCHEDULE_TZ`,
  `BILLING_ALERT_EMAIL` from the budget resource, region — Discord secrets stay in `discord.json`).
  Skips files that already exist unless `--force`, so it never clobbers local edits. Run it per game
  (`GAME=<id>`); nothing is deployed. See the memory note "config-reconstruction" for the source-map.

Everything the CLI and the local test server touch on your machine lives under `./local/`
(gitignored as a whole — machine-local scratch, safe to delete), organized by purpose, then game:

```
local/
  backups/<game-id>/    tarballs from `backup pull`
  seeds/<game-id>/      seed saves staged for `world push` (expanded dirs or .tar.gz)
  server/<game-id>/     docker-compose.local.yml bind mounts (gamefiles/ + data/)
```

Tarball vs expanded, the rule everywhere: **expanded where a server runs** (the EC2 data volume,
`local/server/<game-id>/data`), **tarballs where archives are stored** (S3, `local/backups`).

## World bootstrap (seeding a friend's save)

Seed archives are the same format as backups — the data volume tarred from its root — but live under
`s3://<backup-bucket>/bootstrap/<game-id>/`, a separate prefix the backup rotation never touches.

1. **Lay the save out like the data volume root.** For Abiotic Factor that means the directory you
   push contains `SaveGames/Server/Worlds/<WorldSaveName>/` (plus optionally
   `SaveGames/Server/Admin.ini` and `Config/WindowsServer/`). `world push` warns if the expected
   `savePath` subtree is missing.
2. **Push it:** `npm run cli world push ./friends-save FriendsWorld` — tars and uploads to
   `bootstrap/<game-id>/FriendsWorld.tar.gz`. (A `.tar.gz` in the right format — e.g. one from
   `backup pull` — can be pushed as-is.) A bare name resolves in the staging dir:
   `world push FriendsWorld` finds `local/seeds/<game-id>/FriendsWorld/` (or `.tar.gz`).
3. **Match the world name.** The `<WorldSaveName>` folder inside the archive must match the active
   world's `worldName` in `config/<game>.worlds.json` — that's what the server is told to load.
4. **Restore it:** start the server (`/gate start`), then `npm run cli world restore FriendsWorld.tar.gz`.
   The current data is backed up first, so a bad seed is recoverable via `backup restore`.
