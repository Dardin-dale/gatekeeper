# GATEKeeper — Development Plan

A cost-effective, multi-game AWS server manager with Discord control, built on a
`GameProfile` abstraction. First game: **Abiotic Factor**. Adapted from
[huginbot](https://github.com/Dardin-dale/huginbot) (Valheim).

---

## Status

### Done & committed
- **Phase 0 — Isolation from live huginbot.** Game-derived stack name (`GateStack-AbioticFactor`),
  per-game SSM subtree (`/gatekeeper/<game>/*`), prefixed CFN exports, EC2 tag/IAM aligned. Verified by
  synth that `ValheimStack` is never in the change set.
- **Phase 1 — GameProfile backbone.** `lib/games/{types,index,abiotic-factor,valheim,_template}.ts`;
  `GAME` selector; per-game generic domain (`BASE_DOMAIN` → `<subdomain>.<base>`).
- **`/gate` ping milestone.** One namespaced command (hail/start/stop/status/join/setup/help); persona
  helper + Dr. Manse hologram `/hail`; local dev server (`scripts/local-dev.ts`) for ngrok testing.
- **Phase 2 — CDK generification.** Security-group ports, instance type, data volume from the profile.
  Config-split: worlds load from gitignored `config/<game>.worlds.json` (→ `WORLDS_JSON`), with an
  optional per-guild `default` world. Dropped the PlayFab path; monitoring simplified to **A2S only**.
- **AF runtime de-risked (local Tier-2 test PASSED).** Verified against the upstream image and a live
  local container: image pulls, loads our world, A2S answers. See *Verified AF specs* below.

### Validated locally (the proof)
`docker compose -f docker-compose.local.yml up` boots the real AF server; `node scripts/a2s-query.js
127.0.0.1 27015` returns `LIVE {game:"Abiotic Factor", players:0, maxPlayers:6}`. Image, `WorldSaveName`,
the `AsyncTaskTimeout` fix, and A2S monitoring are all confirmed on real hardware.

---

## Remaining work (the plan from here)

### Phase 3 — EC2 runtime (makes `/gate start` actually boot AF) ✅ DONE (commit d97456b)
- [x] Emit `game-profile.json` from the stack into the scripts S3 asset via `Source.jsonData`
      (`lib/games/index.ts:runtimeProfile`) — the single bridge to the bash runtime.
- [x] Profile-driven `scripts/game/start-server.sh`: `docker run` the profile's image with env from
      `envMap` + `staticEnv`, `AdditionalArgs = defaultArgs + world.extraArgs`, the profile's volumes
      and ports. Mount renamed `/mnt/valheim-data` → `/mnt/game-data`.
- [x] **First-boot resilience** — `--restart unless-stopped` covers the transient SteamCMD "Missing
      configuration" exit (validated locally: a re-run pulls cleanly).
- [x] Dropped the Valheim/BepInEx/mod user-data + `scripts/valheim/` start/switch/monitor scripts and
      the PlayFab/player-monitor/valheim-server systemd units.
- [x] `start.ts` resolves the per-guild default world → writes `active-world` to SSM; `start-server.sh`
      reads it → `WorldSaveName`. (PlayFab join-code clear removed; GATEKeeper branding.)
- [x] Verified: synth emits the correct AF profile JSON; a stubbed dry-run of `start-server.sh`
      produces a `docker run` identical to `docker-compose.local.yml`.

### Phase 4 — On-host A2S monitor (auto-shutdown + readiness) ✅ DONE (commit pending)
Decided **on-host** (not a Lambda): the monitor queries A2S on `127.0.0.1`, so the query port
(27015) stays **closed to the internet** — only the game port is public. Reuses `a2s-query.js`,
no always-on EventBridge.
- [x] `services/game-monitor.service` runs `scripts/game/monitor.sh` (game-agnostic, reads the profile).
- [x] Loop: `node a2s-query.js 127.0.0.1 <queryPort>` → player count → SSM `/gatekeeper/<game>/player-count`
      + CloudWatch (`GameServer` namespace).
- [x] Idle tracking via `/tmp` activity file; `StopInstances` after `backup-server.sh` when idle >
      `auto-shutdown-minutes`. **Idle only accrues after the first A2S success**, so the slow
      Wine+SteamCMD first boot is never mistaken for idle.
- [x] Readiness: on the down→up transition, posts "🟢 Server Online — join `<publicIP>:<gamePort>`"
      straight to the world's Discord webhook (SSM SecureString).
- [x] `scripts/game/backup-server.sh` (new): tars the profile's `savePath` → S3 (EBS already persists
      across stop/start, so this is for DR + CLI download). Node 18 installed in user-data for the helper.
- [x] Verified by stubbed dry-run: readiness fires once, players>0 holds the box up, idle>threshold
      triggers backup+stop (graceful if backup fails).

### Phase 5 — Notifications & derived domain ✅ DONE (commit pending)
- [x] **Notifications consolidated.** The on-host monitor posts readiness + idle/backup messages
      directly to the webhook, so `discord-notifications.ts` is trimmed to the one event the host
      can't send — the final EC2 **stopped** confirmation (rebranded to the Manse persona via
      `personaEmbed`). Removed the dead `valheim.server` / `Backup.*` EventBridge rules + handlers.
- [x] **Route 53 derived domain.** Replaced the `CUSTOM_URL` gate with `gameDomain()` →
      `<subdomain>.<BASE_DOMAIN>` (e.g. `abiotic.gjurdsihop.net`), passed to the update-route53 +
      notifications lambdas; `CustomDomain` output now `<domain>:<gamePort>`. `update-route53.ts`
      already handled subdomains. Verified both branches by synth (domain set vs unset).
- [x] `/gate join` already uses `gameDomain()`; the monitor's readiness ping prefers `GAME_DOMAIN`
      (from `/etc/gatekeeper.conf`) and falls back to the public IP.
- [x] **Fixed a Phase-4 regression:** `/gate stop` (normal path) referenced the deleted
      `backup-and-stop.sh` — recreated it game-agnostic (`backup-server.sh` → stop). Removed the
      orphaned force-stop EventBridge emit; debranded `stop.ts`; deleted stale `apply-userdata-fixes*`.

### Phase 6 — Cleanup, docs, deploy (in progress)
- [x] **Backup correctness** — archive the whole data/saves volume (captures AF's `Admin.ini` +
      server config, not just `Worlds`); verified against the real local save layout.
- [x] **Persona/flavor** — `help`/`status`/`setup` refactored onto the persona helper + AF's
      address-join model (no more Valheim join codes / HuginBot strings); deleted dead `worlds`/
      `backup`/`mods` handlers.
- [x] **CLI trim** — replaced the ~9.5k-line Valheim CLI with a small game-aware one
      (`backup list|pull|create`, bucket/instance discovered from stack outputs). Server control
      stays in Discord.
- [x] **Docs** — rewrote `CLAUDE.md` for the GameProfile architecture, `docs/cli.md`,
      `docs/custom-domain.md`; added `docs/adding-a-game.md`; refreshed `.claude/skills/*`.
- [x] **Pre-deploy review fixes** — corrected the Interactions Endpoint URL docs (it's
      `<ApiEndpoint>interactions/control`, README + `discord-setup.md` both said otherwise);
      debranded `discord-setup.md`; **seeded `/gatekeeper/<game>/active-world` at deploy** from the
      default world in `config/<game>.worlds.json` so the first boot (which happens at deploy)
      runs the configured world + password instead of the passwordless image defaults
      (`/gate start` overwrites the param at runtime; CFN only resets it when the seeded value
      changes); **gitignored Jest snapshots** + pointed CDK tests at `test/fixtures/config/` —
      the tracked snapshot had embedded the real `WORLDS_JSON` (password + guild ID). NOTE: the
      secret remains in local git history — rotate the world password or scrub history before
      pushing the repo.
- [x] **World bootstrap CLI** — `cli world push|list|restore` + `cli backup restore`, backed by the
      on-host `scripts/game/restore-world.sh` (SSM-triggered: stop game → safety backup → extract →
      restart). Seeds live under `bootstrap/<game-id>/` so rotation can't eat them; one archive
      format (data-volume root) shared with backups. Also fixed `cleanup-backups.ts`, which still
      rotated huginbot's `worlds/` prefix — i.e. rotation NEVER ran against `backups/<game-id>/` —
      and removed the dead `worldBootstrapLocation` first-boot user-data seam it replaces.
- [ ] Optional: refresh the remaining secondary setup guides (`aws-setup`, `troubleshooting`).
- [ ] **Legacy API naming cleanup** — the REST API construct is still `HuginbotApi` (shows up as the
      `HuginbotApiEndpoint...` stack output) with display name "HuginBot Discord API". The
      `restApiName` *property* is safe to change in place, but renaming the *construct ID* REPLACES
      the API Gateway → new endpoint URL → re-wire the Discord Interactions Endpoint URL after.
      Do it alongside some other instance-replacing change, not casually.
- [x] **Real deploy** — live and operating (AL2023 host; IMDSv2 ping fix debugged against the
      running instance). Redeployed 2026-06-10 onto the Phase-9 baseline.

### Phase 7 — Profile-driven mods (implemented; first deploy pending)
Mods return as generic infrastructure (Phase 3 deliberately dropped the Valheim-specific
BepInEx scripts; this is their multi-game replacement). See `docs/mods.md` for the model.
- [x] **`GameProfile.mods` contract** — per-game install `kinds` (metadata kind → host
      `targetPath` + optional container env), `source` (thunderstore | manual), `clientsMustMatch`.
      AF: `pak` into `Content/Paks` (UE4SS deliberately unsupported — loader broken under Wine
      post-1.3.0). Valheim: `bepinex-plugin` + `BEPINEX=true` from Thunderstore.
- [x] **Host installer** — `start-server.sh` syncs the active world's mods from the S3 library on
      start, **manifest-tracked** (only ever removes files it installed — AF paks share the dir
      with base-game pakchunks). Bad/missing mods warn + skip, never block the start.
- [x] **Per-world `mods` array** in `config/<game>.worlds.json` (flows to the host via the
      active-world SSM param, which already carried the whole WorldConfig).
- [x] **CLI library** — `cli mods list|add|import|info|remove` against
      `s3://<bucket>/mods/<Name>/`; `import` is Thunderstore-only (AF/Nexus has no headless API,
      so AF mods are download-then-`add`).
- [x] **Discord** — `/gate mods [world]` (mod list + portal links + client-install warning) and
      `/gate worlds` (startable worlds, default marker, mod counts).
- [x] **Production validation (bepinex kind)** — BetterNetworking_Valheim installs per-world on
      the live Valheim stack (manifest sync verified in the host journal).
- [ ] **Tier-2 validation (pak kind)** — local compose run with a real AF pak mod (verify load +
      clean removal), then a deployed AF world with one mod. The AF library is still empty.

### Phase 8 — Valheim port ✅ DEPLOYED (2026-06-10)
`GateStack-Valheim` is live as **MuninBot** (`/munin`) — Munin, the *other* raven, so commands and
persona never collide with the legacy huginbot during migration. GjurdsIHOP migrated from the
huginbot backup (`cli world push/restore`), BetterNetworking via `cli mods import`, adminIds mapped
to `ADMINLIST_IDS`, per-world `extraArgs` (`-crossplay -modifier resources more`). Full
start→play→stop→offline cycle verified in Discord. Checklist + field notes: `docs/GAME-CANDIDATES.md`.
Remaining: retire the huginbot stack once Munin has earned trust. **Next game: Core Keeper**
(prereq: optional-password contract change; design in GAME-CANDIDATES).

### Phase 9 — Presence + crossplay monitoring (✅ 2026-06-10, shipped with the Valheim deploy)
- [x] **Presence sidecar** (`presence.js` + `game-presence.service`): a gateway connection from the
      host keeps each bot ONLINE in Discord with "Playing <game> (N online)" — serverless
      interactions can't hold one, which is why bots looked offline. `PartOf game-server.service`,
      so presence ⇔ server status. Token seeded once per game via `cli discord put-token`
      (SecureString; CFN can't create those).
- [x] **Crossplay Valheim is A2S-SILENT** (PlayFab networking) — found live when the monitor never
      saw the healthy server and the boot-timeout nearly stopped it. Fix: profile-driven
      `playersLogPattern` log-heartbeat fallback (liveness = match <5 min; count = last number).
      A2S stays the primary path. This is the `logs` arm of the QueryStrategy idea, landed early.
- [x] **Join rendering generalized**: join-code games get the full address/password/code field set;
      `codeLabel` ("Lobby Code" AF / "Join Code" Valheim) and `addressWithPort` (Valheim's one-box
      `host:port`) are profile fields; the scrape pattern must include the code (`'join code [0-9]+'`).
- [x] **Persona polish**: lifecycle flavor lines per persona (`Persona.lines` — no more facility-speak
      from Munin), embed de-dup vs. the Discord app's own theming (thumbnail opt-in, no botName
      footer prefix, byline off for webhook posts), `/hail` title de-AF'd.
- [x] **Fix:** don't publish the A2S query port separately when a UDP range covers it (Valheim's
      2457 ⊂ 2456-2458 → Docker "port is already allocated" broke the first boot).

---

## Future directions (deferred)

### Public assets bucket for persona images (TODO)
Today `persona.thumbnailUrl` hotlinks the Manse hologram from the Abiotic Factor wiki
(`https://abioticfactor.wiki.gg/images/Hologram.PNG`) — zero infra, but it depends on the wiki keeping
that URL. The robust version: a **public-read S3 assets bucket** the stack deploys `images/` into, with
the object URL written to SSM (`/gatekeeper/<game>/persona/thumbnail-url`) + a Lambda env var at deploy.
Then `personaEmbed` (embed author/thumbnail) and the host webhook posts (`username`/`avatar_url`) read
the self-hosted URL, with `persona.thumbnailUrl` as the fallback override. Makes the Manse identity
self-contained on AWS (no wiki/GitHub dependency) and is the prerequisite for the bot to *post as*
Dr. Manse (avatar) rather than just show the thumbnail.

### Multi-game model — DECIDED: Model A (one Discord app + one stack per game) — PROVEN IN PROD
Both stacks live side-by-side since 2026-06-10 (GateStack-AbioticFactor + GateStack-Valheim).
Each game is its own Discord app **and** its own `GateStack-<Pascal>` (own EC2/EBS/API/Lambda/SSM
subtree), deployed independently. Chosen for its simplicity and cost isolation: spinning up a Discord
app per game is trivial, and a game you aren't playing costs ~$0 (instance auto-stops; `cdk destroy`
its stack for true $0, the RETAIN'd EBS keeps the world). Per-game creds live in
`config/<game>.discord.json`; `commandName` gives each game its own branded top-level command
(`/gate`, `/munin`) so the picker stays unambiguous in a shared server.

Cost basis for the decision: the VPC is **public-subnet only (no NAT gateway)**, so there's no ~$32/mo
idle hole; EC2 compute is the only real cost and auto-stops when idle; a dormant game's floor is just
its ~20 GB EBS (~$2/mo) plus the shared Route 53 zone ($0.50/mo).

**Optional future alternative — omni hybrid (only if managing N apps ever gets annoying):** a shared
control-plane stack (one Discord app / API Gateway / Lambda that routes by `commandName` — the primitive
is already in place) + per-game data-plane stacks (deploy/destroy independently for the same cost
isolation). Not planned; recorded so the door stays open. The `commandName` router field already exists,
so adopting it later is additive, not a rewrite.

---

## Testing strategy (tiers)
1. **Unit (Jest)** — dispatch, profile registry, world config, mods, A2S parse. Fast, no AWS. *(86 passing)*
2. **Local Docker** — `docker-compose.local.yml` + `a2s-query.js`. Validates the runtime with no AWS spend. *(✅ passing)*
3. **ngrok** — `npm run local-dev` behind a tunnel to test real Discord interactions without deploying.
4. **Deploy** — the isolated `GateStack-AbioticFactor`; only EC2/Route53/API-Gateway need this.

---

## Verified AF specs (reference)
- Image `ghcr.io/pleut/abiotic-factor-linux-docker:latest` (GHCR; Wine + SteamCMD app **2857200**,
  downloads into `/server` on first boot — slow).
- Env: `SteamServerName`, `ServerPassword`, `WorldSaveName` (default `Cascade`), `AdditionalArgs`,
  `AutoUpdate`, `UsePerfThreads`/`NoAsyncLoadingThread`, `MaxServerPlayers` (6).
- **Required default arg:** `-ini:Engine:[OnlineSubsystemSteam]:AsyncTaskTimeout=360` (the default 15s
  Steam-registration timeout fails after the slow download and kills A2S — Pleut issue #4).
- Ports **7777/udp** (game) + **27015/udp** (A2S query).
- Volumes: `gamefiles → /server`, `data → /server/AbioticFactor/Saved`; worlds at
  `…/Saved/SaveGames/Server/Worlds/<WorldSaveName>`.
- Join: **direct `IP:7777`** (recommended) — `address` strategy, not a join code.
- Sizing: **t3.large** / 20GB. Backup image: `andrewsav/abiotic-factor` (Docker Hub).
