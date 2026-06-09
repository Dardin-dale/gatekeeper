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
npm run cli backup pull [name|latest]        # download a backup to ./local/backups
npm run cli backup create                    # trigger a backup on the running server
npm run cli backup restore [name|latest]     # restore a backup onto the running server

npm run cli world push <dir|tar.gz> [name]   # upload a local save as a seed archive
npm run cli world list                       # list uploaded seed archives
npm run cli world restore [name|latest]      # restore a seed archive onto the running server
```

- **`backup list`** — backups live at `s3://<backup-bucket>/backups/<game-id>/<timestamp>.tar.gz`
  (written by `scripts/game/backup-server.sh`, which archives the whole data/saves volume). The
  newest `BACKUPS_TO_KEEP` per game are kept; older ones rotate out daily.
- **`backup pull`** — downloads to `./local/backups/`. `latest` (default) grabs the newest; or pass a
  filename from `backup list`.
- **`backup create`** — runs `backup-server.sh` on the instance via SSM. The server must be running.
- **`backup restore` / `world restore`** — runs `restore-world.sh` on the instance via SSM (server
  must be running): stops the game, **backs up the current data first**, extracts the archive into
  the data volume, and restarts the game (the readiness ping posts to Discord when it's back).

## World bootstrap (seeding a friend's save)

Seed archives are the same format as backups — the data volume tarred from its root — but live under
`s3://<backup-bucket>/bootstrap/<game-id>/`, a separate prefix the backup rotation never touches.

1. **Lay the save out like the data volume root.** For Abiotic Factor that means the directory you
   push contains `SaveGames/Server/Worlds/<WorldSaveName>/` (plus optionally
   `SaveGames/Server/Admin.ini` and `Config/WindowsServer/`). `world push` warns if the expected
   `savePath` subtree is missing.
2. **Push it:** `npm run cli world push ./friends-save FriendsWorld` — tars and uploads to
   `bootstrap/<game-id>/FriendsWorld.tar.gz`. (A `.tar.gz` in the right format — e.g. one from
   `backup pull` — can be pushed as-is.)
3. **Match the world name.** The `<WorldSaveName>` folder inside the archive must match the active
   world's `worldName` in `config/<game>.worlds.json` — that's what the server is told to load.
4. **Restore it:** start the server (`/gate start`), then `npm run cli world restore FriendsWorld.tar.gz`.
   The current data is backed up first, so a bad seed is recoverable via `backup restore`.
