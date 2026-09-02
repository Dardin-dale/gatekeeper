/**
 * GameProfile — the contract every supported game "plugin" implements.
 *
 * It is the single source of truth consumed by three layers:
 *   - CDK (build time):  ports, instance size, image, save path
 *   - runtime bash (EC2): the runtime-relevant subset is serialized to
 *                         game-profile.json and read with jq
 *   - Discord lambdas:    persona (embeds, /gate hail, /gate join)
 *
 * Keep every field JSON-serializable — the runtime subset is emitted verbatim.
 * A profile describes HOW to run a game; it never contains WHAT worlds/passwords
 * to run (those are gitignored per-game config seeded into SSM). No secrets here.
 */
export interface GameProfile {
  /** Stable id; drives stack name, SSM subtree, config filename. e.g. 'abiotic-factor'. */
  id: string;
  /** Human-facing name. e.g. 'Abiotic Factor'. */
  displayName: string;

  /**
   * Top-level Discord slash command for this game, e.g. 'gate' → `/gate start`,
   * 'munin' → `/munin start`. The subcommand set (start/stop/status/hail/join/
   * setup/help) is identical across games; only this namespace word differs.
   * It's the router key: a single-game deploy registers just this command; a
   * future omni deploy (one Discord app, many games) registers each game's
   * commandName and the dispatcher routes by it.
   */
  commandName: string;

  /**
   * DNS label for this game under the shared base domain (BASE_DOMAIN), e.g.
   * 'abiotic' -> abiotic.<BASE_DOMAIN>. Defaults to `id` when omitted. Each game
   * gets its own record in the ONE shared hosted zone — not a separate zone.
   */
  subdomain?: string;

  container: ContainerSpec;

  /** Inbound game ports opened on the security group. */
  ports: PortRange[];
  /**
   * Steam A2S query port. REQUIRED — monitoring (player count, liveness, idle
   * shutdown) is done by querying A2S here, so every supported game must expose
   * one. Almost all Steam dedicated servers do.
   */
  queryPort: number;

  /**
   * Optional A2S fallback for the PLAYER COUNT: an ERE matched against the
   * container's FULL log (not a time window) whose LATEST match's LAST number is
   * the current count. Use the game's join/LEAVE *event* lines so the latest one
   * always reflects the live count — for Valheim, "... now N player(s)" (logged
   * on every join and disconnect). Do NOT point this at a periodic "N players
   * online" heartbeat: under crossplay that heartbeat can be PlayFab-blind and
   * report a stale 0, which would idle-kill a connected player. The full-log
   * (un-windowed) scrape is deliberate — a player who joined and then sat quietly
   * emits no new line, so a windowed scrape would read 0 and shut them down.
   * Needed when a game stops answering A2S in some mode (Valheim -crossplay ->
   * PlayFab networking goes A2S-silent). See livenessLogPattern for the matching
   * "server is up" signal. (Interim QueryStrategy carve-out — docs/GAME-CANDIDATES.md.)
   */
  playersLogPattern?: string;

  /**
   * Optional A2S-silent LIVENESS signal: an ERE matched against the container's
   * full log; any match means the server is up/joinable. Distinct from
   * playersLogPattern because the count must come from join/leave events (which
   * only appear once players come and go), while liveness needs a signal present
   * at 0 players the moment the server registers — for Valheim, the recurring
   * session heartbeat "... is active with N player(s)". Drives the readiness ping
   * and keeps the boot-timeout from killing a healthy empty server. Only consulted
   * when A2S is silent and playersLogPattern is set.
   */
  livenessLogPattern?: string;

  /**
   * Optional EVENT-bookkeeping count for games whose log reports joins/leaves as
   * discrete events carrying a username, not a running count. The monitor counts
   * net presence = (#playerJoinPattern matches − #playerLeavePattern matches)
   * over the FULL log. Use when A2S answers but UNDERCOUNTS — Abiotic Factor
   * answers A2S yet always reports 0 players because clients join over EOS, which
   * A2S can't see (verified live: A2S_INFO and A2S_PLAYER both 0 with a player
   * connected). When set, this OVERRIDES the A2S player count; liveness still
   * comes from A2S (or livenessLogPattern). Both patterns must be set together.
   *
   * Caveat: an ungraceful disconnect (crash/timeout) that logs no leave line
   * leaves the count high — the server then stays up longer but NEVER idle-kills a
   * connected player (the safe failure direction). Pair with a sane auto-shutdown
   * window as the cost backstop. The patterns should also be specific enough that
   * a player can't trip the count by typing the phrase in chat; over-counting only
   * delays shutdown, so err toward matching.
   */
  playerJoinPattern?: string;
  playerLeavePattern?: string;

  /**
   * Optional flavor: in-game happenings worth announcing to Discord (player
   * deaths, raids, joins/leaves…). The on-host monitor scrapes container logs
   * each cycle, posts a persona embed per NEW match (deduped), and gates them all
   * behind the `events` notification toggle (`/<cmd> notify`). Edge-triggered —
   * the mirror of the player count: a short time window + dedup, not the full
   * log. Up to ~one monitor cycle (≈2 min) of delay; flavor, not telemetry.
   */
  events?: GameEvent[];

  /**
   * Optional: what the server is doing before it answers a liveness check, read
   * out of container logs. Without it the whole pre-live window is one opaque
   * "Starting…" — a stale-build server once sat that way for 45 min while
   * actually running and unjoinable.
   *
   * Resolution each cycle, against the whole container log:
   *   1. any entry with `failure: true` wins outright — a failed update must not
   *      be masked by the later phases a stale-but-running server still logs;
   *   2. otherwise the LAST matching entry wins, so list the rest in boot order
   *      (earliest phase first, latest last).
   * Publishes to SSM boot-phase (read by `/<cmd> status`) and edits the Discord
   * status message in place.
   */
  bootPhases?: BootPhase[];

  /** Default EC2 instance type (overridable via the INSTANCE_TYPE env var). */
  instanceType: string;
  /** Persistent-data EBS volume size in GB. */
  dataVolumeSizeGb: number;

  /**
   * Idle auto-shutdown window: minutes of player-idle before the monitor backs
   * up and stops the instance — the core cost control. A number, or 'off' to
   * never idle-stop. Seeds the SSM param `/gatekeeper/<game>/auto-shutdown-
   * minutes` at deploy; the `.env` AUTO_SHUTDOWN_MINUTES overrides it as an
   * escape hatch. Tunable at runtime via `npm run cli config set auto-shutdown
   * <min|off>` (the monitor re-reads SSM each cycle, so no restart). Default 15.
   */
  autoShutdownMinutes?: number | 'off';
  /**
   * Boot-timeout safety net: minutes to wait for first liveness before stopping
   * a wedged boot so it can't bill indefinitely. A number, or 'off'. Same
   * precedence as autoShutdownMinutes — profile default, `.env`
   * BOOT_TIMEOUT_MINUTES overrides, `cli config set boot-timeout` retunes at
   * runtime. Default 45 (first boot pulls several GB; later boots are fast).
   */
  bootTimeoutMinutes?: number | 'off';
  /**
   * Hours after a session ends before its lifecycle status message auto-deletes
   * from the channel (keeps the channel from accreting stale session posts). A
   * number, or 'off' to keep messages forever. Seeds SSM
   * `/gatekeeper/<game>/message-ttl-hours`; `.env` MESSAGE_TTL_HOURS overrides;
   * `cli config set message-ttl <hours|off>` retunes at runtime. Default 16.
   */
  messageTtlHours?: number | 'off';
  /**
   * Minutes of idle grace the **Extend** status-message button grants per press —
   * the monitor holds off auto-shutdown that long. A number, or 'off' to disable
   * the button. Seeds SSM `/gatekeeper/<game>/extend-minutes`; `.env`
   * EXTEND_MINUTES overrides; `cli config set extend <min|off>` retunes at
   * runtime. Default 5.
   */
  extendMinutes?: number | 'off';

  /**
   * How players connect / how the bot reports "how to join". This is the one
   * per-game carve-out: address-based games (A2S/IP) need nothing special;
   * join-code games (e.g. Valheim crossplay) carry an opt-in code fetcher.
   */
  join: JoinStrategy;

  /**
   * How this game takes mods, if it does. Omit for games with no (supported)
   * mod story. Mods themselves are per-world WHAT-config (the `mods` array in
   * config/<game>.worlds.json names entries in the S3 mod library); this spec
   * is the per-game HOW: which install kinds exist and where their files land.
   */
  mods?: ModsSpec;

  persona: Persona;
}

/**
 * One stage of the pre-live boot, detected from container logs (see
 * GameProfile.bootPhases). JSON-serializable — it rides game-profile.json.
 */
export interface BootPhase {
  /** Stable id; also the value published to SSM boot-phase. */
  id: string;
  /** ERE matched against the container log (grep -E) to detect this phase. */
  pattern: string;
  /** Short human label for Discord / `/<cmd> status`, e.g. 'Downloading update'. */
  label: string;
  /** Leading emoji for the status line. Defaults to ⏳ when unset. */
  emoji?: string;
  /**
   * Optional ERE whose last match carries a 0-100 progress number (e.g. SteamCMD's
   * `progress: 42.39`); the host takes the last numeric token of that match.
   * Rendered next to the label so a long download reads as moving, not hung.
   */
  progressPattern?: string;
  /**
   * Marks a TERMINAL failure — the boot cannot succeed from here (e.g. SteamCMD
   * left the app flagged Update Required). Announced immediately rather than
   * after the boot-timeout window: the signal is "this will never come up".
   */
  failure?: boolean;
}

/**
 * An in-game happening the host announces to Discord (see GameProfile.events).
 * Every field is JSON-serializable (it rides game-profile.json to the host).
 */
export interface GameEvent {
  /**
   * Stable id, also the dedup namespace. Purely informational on the host today
   * (all events share the one `events` toggle), but keep it unique per game.
   */
  id: string;
  /** ERE matched per container-log line (grep -E) to detect the event. */
  pattern: string;
  /**
   * Hold this event one monitor cycle and post it only if the player count has
   * NOT recovered — for leave events on games that log a disconnect line for any
   * transient drop. Valheim emits "Player connection lost" on ordinary network
   * blips, so announcing on the raw line spams a departure notice every time
   * someone reconnects seconds later. Costs up to one cycle of delay (≈2 min
   * while live), which is fine for flavor and wrong for anything load-bearing.
   */
  confirmDrop?: boolean;
  /**
   * Embed title for the post. `{name}` is replaced with the value nameSed
   * extracts (or '' when nameSed is unset / matches nothing).
   */
  title: string;
  /** Optional embed body; `{name}` substituted too. Omit for a title-only post. */
  body?: string;
  /**
   * Optional `sed -E` substitution applied (with a trailing `p`) to a matched
   * line to produce the name for `{name}` — a capture-group expression like
   * `s/.*ZDOID from (.+) : 0:0.*` + backref. Omit when the line carries no usable
   * name (the title then stays static). See valheim.ts / abiotic-factor.ts.
   */
  nameSed?: string;
  /** Embed accent color (decimal). Defaults to the persona color on the host. */
  color?: number;
  /**
   * Notify toggle group this event belongs to, so several entries can share one
   * `/<cmd> notify` switch — e.g. every Valheim raid variant uses category 'raid'.
   * Defaults to `id`. The host gates the post on `notify_enabled <category>`.
   */
  category?: string;
  /**
   * Friendly label for the category in `/<cmd> notify list` / the command's
   * choices (e.g. 'Raids', 'Deaths'). Only needs to be set on ONE event per
   * category; defaults to the category key.
   */
  label?: string;
  /**
   * Dedup by the extracted {name} instead of by the log line. Use for "joins"
   * announced off a per-spawn line (Valheim names a player only at character
   * spawn, which re-fires on every respawn): keying on the name announces each
   * player once per session and skips respawns. Requires nameSed. Default false
   * (dedup per line — right for deaths/raids, where each occurrence is distinct).
   */
  dedupByName?: boolean;
}

/**
 * Per-game mod support. The S3 mod library (s3://<backup-bucket>/mods/<Name>/)
 * is the normalization layer: every library entry declares a `kind` in its
 * metadata.json, and by install time a mod is just "files + kind". The host
 * start script copies each of the active world's mods into the kind's
 * targetPath (cleaning up the previous set via a manifest), so the bash stays
 * game-agnostic — this map is the only place install mechanics differ.
 */
export interface ModsSpec {
  /**
   * Install kinds this game accepts, keyed by the `kind` in a library mod's
   * metadata.json — e.g. 'pak' (AF), 'bepinex-plugin' (Valheim).
   */
  kinds: Record<string, ModKind>;
  /**
   * Where mods come from, for the CLI. 'thunderstore' enables headless
   * `cli mods import` (anonymous package download API); 'manual' means
   * download-it-yourself + `cli mods add` (e.g. Nexus Mods, whose API gates
   * automated downloads). Default: manual with no portal link.
   */
  source?:
    | { type: 'thunderstore'; community: string }
    | { type: 'manual'; portalUrl?: string };
  /**
   * True when players must install the SAME mods on their clients to join
   * (no server-side sync/handshake). Drives the warning + per-mod links in
   * /gate mods so the world's mod list doubles as the client install list.
   */
  clientsMustMatch?: boolean;
}

export interface ModKind {
  /**
   * HOST directory the kind's files are copied into — absolute, on/under the
   * persistent data volume's bind mounts so installs survive stop/start and
   * instance replacement (e.g. AF paks live inside the gamefiles mount).
   */
  targetPath: string;
  /**
   * Container env to add when at least one mod of this kind is installed
   * (e.g. Valheim's { BEPINEX: 'true' } to enable the loader).
   */
  env?: Record<string, string>;
}

export interface ContainerSpec {
  /** Docker image reference. */
  image: string;
  /** Container name on the host. */
  name: string;
  /** Env vars always set on the container (e.g. { AutoUpdate: 'true' }). */
  staticEnv: Record<string, string>;
  /**
   * Maps canonical config fields -> this game's container env var names.
   * e.g. AF: { password: 'ServerPassword', serverName: 'SteamServerName' }.
   * Omitted entries mean the game has no corresponding env var.
   */
  envMap: EnvMap;
  /** Host <-> container bind mounts for persistent data. */
  volumes: VolumeMount[];
  /** Path holding world saves (relative to the data volume mount). */
  savePath: string;
  /**
   * Disposable dirs to exclude from the S3 backup tar (paths relative to the data
   * volume root, tar `--exclude` patterns). Use for a game image's OWN backup dir
   * that lives inside the volume — archiving it re-archives every prior backup,
   * compounding the tar each session. e.g. Valheim (lloesche): `['./backups']`.
   * Logs + crash reports are always excluded regardless.
   */
  backupExcludes?: string[];
  /** Launch args always applied for this game (combined with a world's extraArgs). */
  defaultArgs?: string;
  /**
   * For games whose image has NO admin env var (so `envMap.adminIds` can't
   * apply): the host renders the world's `adminIds` into this file on the data
   * volume before every start, making the admin list reproducible from
   * `config/<game>.worlds.json` instead of hand-maintained on the volume.
   * e.g. AF: { path: 'SaveGames/Server/Admin.ini', header: '[Moderators]',
   *            line: 'Moderator={id}' }.
   * Only written when the world sets `adminIds`; a world without them leaves
   * an existing file untouched. Games with an admin env var (Valheim's
   * ADMINLIST_IDS) use `envMap.adminIds` and omit this.
   */
  adminFile?: AdminFileSpec;
}

export interface AdminFileSpec {
  /** File path relative to the data volume root (the LAST entry in `volumes`). */
  path: string;
  /** Optional first line(s) of the file, e.g. an INI section header. */
  header?: string;
  /** Per-id line template; `{id}` is replaced with each id from `adminIds`. */
  line: string;
}

export interface EnvMap {
  serverName?: string;
  worldName?: string;
  password: string;
  adminIds?: string;
  extraArgs?: string;
}

export interface VolumeMount {
  hostPath: string;
  containerPath: string;
}

export interface PortRange {
  protocol: 'udp' | 'tcp';
  from: number;
  to: number;
}

/**
 * Join info: a plain host:port address, or a game-specific join code from logs.
 * `hint` carries the game's own connect instructions (which menu, what the
 * fields are called) so /gate join can render per-game guidance without
 * per-game code. Address-type games get the host/port/password reported as
 * SEPARATE embed fields — most direct-connect dialogs ask for them separately.
 */
export type JoinStrategy =
  | {
      type: 'address';
      port: number;
      hint?: string;
      /**
       * Optional: some address games ALSO mint a per-session lobby/join code,
       * printed in the server logs (AF: 'Session short code: OKNPD'). An ERE
       * matched against container logs by the on-host monitor at first
       * liveness; the LAST whitespace-separated token of the latest match is
       * the code, written to SSM /gatekeeper/<game>/join-code for /gate join.
       * NOTE: the pattern must INCLUDE the code itself (grep -oE extraction).
       */
      codeLogPattern?: string;
      /** What this game's UI calls the code ('Lobby Code' for AF). Default: 'Join Code'. */
      codeLabel?: string;
    }
  | {
      type: 'join-code';
      /** ERE for the code in container logs; must INCLUDE the code (see above). */
      logPattern: string;
      hint?: string;
      /** What this game's UI calls the code. Default: 'Join Code'. */
      codeLabel?: string;
      /**
       * Render the address as one copyable "host:port" and drop the separate
       * Port field — for games whose connect box takes a single string
       * (Valheim's add-server / Steam favorites). Default: separate fields,
       * which suits dialogs with distinct IP/Port boxes (AF's Direct Connect).
       */
      addressWithPort?: boolean;
    };

export interface Persona {
  /** The bot's name. e.g. 'GATEKeeper'. */
  botName: string;
  /** In-universe character whose first-person voice the bot speaks in. */
  characterName: string;
  /** Embed accent color. */
  color: number;
  /** Public URL of the character thumbnail (Discord needs a URL, not a local file). */
  thumbnailUrl?: string;
  /**
   * Public URL of the BOT's icon (its Discord app icon). Used as the avatar on
   * host webhook posts so they read as coming from the bot, while the character
   * `thumbnailUrl` rides inside the embed. Falls back to thumbnailUrl when unset.
   * e.g. https://cdn.discordapp.com/app-icons/<app-id>/<hash>.png
   */
  iconUrl?: string;
  /** Embed footer text. */
  footer: string;
  /** First-person lines for the /gate hail ping test. */
  hailQuotes: string[];
  /**
   * Optional in-character one-liners for lifecycle messages (flavor only —
   * operational details like boot time or the join hint are appended by the
   * handlers). Neutral defaults when omitted.
   */
  lines?: {
    /** /gate start acknowledgement. Default: 'The server is powering up.' */
    starting?: string;
    /** Final EC2-stopped notification. Default: 'The server has shut down completely.' */
    offline?: string;
    /** /gate schedule set confirmations (random pick). Neutral default when omitted. */
    scheduled?: string[];
    /** Scheduled-opening countdown posts at T-60/T-10 (random pick). Neutral default. */
    countdown?: string[];
  };
}
