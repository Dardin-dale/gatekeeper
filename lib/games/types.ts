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
   * 'hugin' → `/hugin start`. The subcommand set (start/stop/status/hail/join/
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

  /** Default EC2 instance type (overridable via the INSTANCE_TYPE env var). */
  instanceType: string;
  /** Persistent-data EBS volume size in GB. */
  dataVolumeSizeGb: number;

  /**
   * How players connect / how the bot reports "how to join". This is the one
   * per-game carve-out: address-based games (A2S/IP) need nothing special;
   * join-code games (e.g. Valheim crossplay) carry an opt-in code fetcher.
   */
  join: JoinStrategy;

  persona: Persona;
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
  /** Launch args always applied for this game (combined with a world's extraArgs). */
  defaultArgs?: string;
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
  | { type: 'address'; port: number; hint?: string }
  | { type: 'join-code'; logPattern: string; hint?: string };

export interface Persona {
  /** The bot's name. e.g. 'GATEKeeper'. */
  botName: string;
  /** In-universe character whose first-person voice the bot speaks in. */
  characterName: string;
  /** Embed accent color. */
  color: number;
  /** Public URL of the character thumbnail (Discord needs a URL, not a local file). */
  thumbnailUrl?: string;
  /** Embed footer text. */
  footer: string;
  /** First-person lines for the /gate hail ping test. */
  hailQuotes: string[];
}
