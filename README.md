# GATEKeeper

A cost-effective, **multi-game** AWS dedicated-server manager with Discord integration.
Start, stop, mod, and join your co-op servers straight from Discord — and only pay for the hours
you actually play. Each game gets its own bot persona, stack, and slash command.

> *"This is a recorded message from Director Manse. The Cascade facility is online."*
> The Abiotic Factor bot speaks as **Dr. Derek Manse**; the Valheim bot is **Munin**, the
> All-Father's memory raven.

> **Status: two games live** — Abiotic Factor (`GateStack-AbioticFactor`, `/gate`) and Valheim
> (`GateStack-Valheim`, `/munin`), each with per-world mods and a presence sidecar. Adapted from
> [huginbot](https://github.com/Dardin-dale/huginbot) (a Valheim-only predecessor) onto a generic
> `GameProfile` backbone. Roadmap: `docs/DEVELOPMENT-PLAN.md`; next games: `docs/GAME-CANDIDATES.md`.

## What it does

- **Discord control** — manage the server with `/gate` slash commands (`start`, `stop`, `status`, `join`)
- **Pay only while playing** — the server auto-stops after a configurable idle timeout (default 20 min);
  a stopped EC2 instance costs ~$0 for compute
- **Player-aware auto-shutdown** — idle detection via Steam **A2S** query, with a profile-driven
  log-heartbeat fallback for games that go A2S-silent (crossplay Valheim runs on PlayFab networking)
- **Bot presence = server status** — a sidecar on the host keeps the bot **online in Discord**
  with a live "Playing <game> (N online)" activity while the server runs; grey means stopped
- **Stable join address** — connect via `your-subdomain.example.net:7777` (Route 53) instead of a changing IP
- **World backups** — scheduled snapshots to S3, downloadable to local disk via the CLI
- **Per-world mods** — an S3 mod library + a `mods` list per world; the host installs them on world
  start, and `/gate mods` shows players what to install client-side (see `docs/mods.md`)
- **Multi-game by design** — game-specific details live in a `GameProfile`; adding another co-op game
  later is "write a profile + deploy," not a rewrite

## Architecture

```
Discord ──▶ API Gateway ──▶ Lambda ──▶ EC2 (Docker)
                              │          ├─ game dedicated server (from the GameProfile)
                              │          ├─ monitor (A2S/log liveness, idle shutdown, pings)
                              │          └─ presence sidecar (bot online while server runs)
                              ├─▶ SSM Parameter Store  (/gatekeeper/<game>/… config + state)
                              └─▶ S3                    (world backups + mod library + scripts)
```

- **EC2** runs the game's dedicated server in Docker (AF: Windows server under Wine;
  Valheim: native Linux image), plus the profile-driven monitor and presence sidecar
- **Lambda** handles Discord interactions (Ed25519-verified) and server lifecycle
- **SSM** holds per-game config/state under `/gatekeeper/<game>/…`
- **S3** stores world backups, the per-game mod library, and the host scripts (synced at boot)

### Multi-game model

One parameterized stack, deployed **once per game**, each fully isolated:

```
GAME=abiotic-factor  →  GateStack-AbioticFactor   (Dr. Manse, /gate  — own EC2/EBS/buckets/SSM subtree)
GAME=valheim         →  GateStack-Valheim         (Munin,    /munin — fully isolated second stack)
```

The **`GAME` env var is the single game selector** for every tool — the CDK deploy (stack name),
the Lambdas, `register-commands`, and the CLI all key off it. Set the default for your checkout in
`.env` (`GAME=abiotic-factor`) and override per-invocation when working with another game:

```bash
GAME=valheim npm run deploy              # deploy a different game's stack
GAME=valheim npm run register-commands   # register that game's Discord commands
GAME=valheim npm run cli backup list     # point the CLI at that game's stack
```

Adding a game = write a profile (copy `lib/games/_template.ts`, see `docs/adding-a-game.md`), add
its `config/<game>.worlds.json` + Discord app creds, and deploy with its `GAME` id. This is what
lets multiple GATEKeeper games — and any unrelated stacks — share one AWS account without
resource collisions.

## Quick start

**Prerequisites:** AWS account + CLI configured ([guide](docs/aws-setup.md)), Node.js 18+, a Discord
server you admin ([guide](docs/discord-setup.md)).

```bash
git clone https://github.com/Dardin-dale/gatekeeper.git
cd gatekeeper
npm install
cp .env.example .env                                                  # AWS region, Discord app values
cp config/abiotic-factor.worlds.example.json config/abiotic-factor.worlds.json   # then edit: worlds + passwords
```

1. **Create a Discord app** (a new one — don't reuse another bot): put the Application ID, Public Key,
   and Bot Token in `.env` (or in `config/abiotic-factor.discord.json`). Invite it with
   **View Channels + Send Messages + Manage Webhooks**.
2. **Configure your world** in `config/abiotic-factor.worlds.json` (name, save name, password, your
   Discord server ID). This file is gitignored — secrets stay out of git.
3. **Deploy:** `source .env && npm run deploy` (creates `GateStack-AbioticFactor`; ~10–15 min).
4. **Register commands:** `npm run register-commands` (global commands take up to ~1 hr to appear).
5. **Wire Discord → infra:** in the Developer Portal, set the **Interactions Endpoint URL** to the
   `ApiEndpoint` deploy output **plus `interactions/control`**
   (e.g. `https://xxxx.execute-api.us-west-2.amazonaws.com/prod/interactions/control`).
   Discord PING-validates it on save.
6. **In Discord:** `/gate setup` (creates the notification webhook), then `/gate start`.

The server takes a few minutes to boot; the join address is posted to your channel when it's ready.

## Discord commands

| Command | Description |
|---------|-------------|
| `/gate setup`  | Initialize GATEKeeper notifications in the current channel |
| `/gate start`  | Start the server |
| `/gate stop`   | Stop the server (backs up first; `force` skips the backup) |
| `/gate status` | Server status + live player count |
| `/gate join`   | Get the connection address (`host:7777`) |
| `/gate worlds` | List the worlds this Discord server can start |
| `/gate mods`   | A world's mod list — what players install to join (`docs/mods.md`) |
| `/gate hail`   | A transmission from Dr. Derek Manse (ping test) |
| `/gate help`   | List the commands |

> The top-level command is the game's own (`commandName` in its profile): `/gate` for Abiotic Factor,
> `/munin` for Valheim. That keeps the picker unambiguous when bots share a Discord server.

## CLI

Server control lives in Discord; the small game-aware CLI covers the out-of-band bits (saves), and
discovers the bucket/instance from the deployed stack — nothing to configure beyond AWS creds:

```bash
npm run cli backup list                    # S3 backups for the active game (GAME=<id>)
npm run cli backup pull [name|latest]      # download a backup to ./local/backups/<game-id>
npm run cli backup create                  # trigger a backup on the running server
npm run cli backup restore [name|latest]   # roll the server back to a backup
npm run cli world push <dir> [name]        # upload a local/friend's save as a seed
npm run cli world restore [name|latest]    # load a seed onto the running server
npm run cli mods list                      # the S3 mod library (docs/mods.md)
npm run cli mods add <zip> [name]          # ingest a downloaded mod (e.g. from Nexus)
npm run cli mods import <Ns/Mod>           # pull from Thunderstore (games with a community)
npm run cli discord put-token              # seed the bot token to SSM (presence sidecar)
```

See `docs/cli.md` (including the save layout for seeding a friend's world).

## Cost

You pay only while the server runs, and several brakes bound the worst case:

- **EC2** `t3.large` ≈ $0.08/hr running, ~$0 stopped. **Auto-shutdown** stops it after idle (default
  20 min); a **boot-timeout** (default 45 min) stops a wedged boot that never comes online.
- **EBS** ~$2.40/mo for the 30 GB of storage (this is the only always-on cost; the world is RETAIN'd).
- **No NAT gateway**, 1-day log retention — the classic surprise costs are designed out.
- **Lambda / API Gateway / S3** — free-tier territory for a friend bot.
- Optional **AWS Budget** email alert (`BILLING_ALERT_EMAIL` in `.env`).

**Realistic:** ~$2.50/mo idle floor, ~$5–15/mo with regular play.

## Credits

- Built on [huginbot](https://github.com/Dardin-dale/huginbot) (the Valheim original)
- Abiotic Factor dedicated server in Docker via Wine —
  [Pleut/abiotic-factor-linux-docker](https://github.com/Pleut/abiotic-factor-linux-docker)
- Game/lore reference — [Official Abiotic Factor Wiki](https://abioticfactor.wiki.gg/)

## License

MIT — see LICENSE.
