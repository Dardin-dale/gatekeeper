/**
 * The single owner of GATEKeeper's SSM Parameter Store surface.
 *
 * Every parameter name, every read/write, and the parse-or-default rules for each
 * live here so the key strings can't drift across the dozen Lambdas + the host
 * scripts that share them. Callers import a named accessor (getServerLive, …) or a
 * key from SSM_PARAMS — they never hand-build a `/gatekeeper/<game>/…` string.
 *
 * Layering: this module owns the SSM *vocabulary*; it borrows the low-level
 * ssmClient + withRetry from ./aws-clients (which knows nothing about our keys),
 * so the dependency points one way and there's no import cycle.
 *
 * NOTE: the host bash/node scripts (scripts/game/*) read the same keys with the
 * AWS CLI and can't import this file. Their names are kept in sync by hand — if a
 * key here changes, grep scripts/ for the literal. The two are validated together
 * by the local-Docker tier, not the type system.
 */
import { GetParameterCommand, PutParameterCommand } from "@aws-sdk/client-ssm";
import { ssmClient } from "./aws-clients";
import { ACTIVE_GAME } from "../../games";
import { WorldConfig } from "./world-config";

// All parameters live under the active game's subtree, so each game's stack is
// self-contained: /gatekeeper/<game-id>/… (matches the host scripts + the stack).
export const SSM_PREFIX = `/gatekeeper/${ACTIVE_GAME.id}`;

/**
 * The full SSM key registry, grouped by lifecycle so the read/write cadence of
 * each is obvious at a glance:
 *
 *  - CONFIG  — durable, rarely changed, survives stop/start (timers, webhooks,
 *              guild defaults, notify toggles). Set at deploy or by an admin.
 *  - SESSION — transient per-session state, cleared on stop by the host scripts
 *              and the offline Lambda (see invalidateSessionParams). Never
 *              meaningful across a stop/start boundary.
 *
 * The wire paths stay flat (no config/ vs session/ prefix) so existing live
 * parameters and the host scripts keep working; the grouping is documentation +
 * the basis for invalidateSessionParams.
 */
export const SSM_PARAMS = {
  // --- CONFIG (durable) ---
  ACTIVE_WORLD: `${SSM_PREFIX}/active-world`, // JSON WorldConfig of the loaded world; rewritten per /<cmd> start
  DISCORD_WEBHOOK: `${SSM_PREFIX}/discord-webhook`, // base path; per-guild webhook is appended (SecureString)
  AUTO_SHUTDOWN_MINUTES: `${SSM_PREFIX}/auto-shutdown-minutes`,
  BOOT_TIMEOUT_MINUTES: `${SSM_PREFIX}/boot-timeout-minutes`,
  MESSAGE_TTL_HOURS: `${SSM_PREFIX}/message-ttl-hours`, // hours after offline before the status message auto-deletes ('off' = keep)
  PREWARM_MINUTES: `${SSM_PREFIX}/prewarm-minutes`, // scheduled openings: start this many minutes before the announced time
  EXTEND_MINUTES: `${SSM_PREFIX}/extend-minutes`, // Extend button: minutes of idle grace added per press ('off' = feature disabled)
  // Per-guild durable status message: /pinned-status/<guild-id> = {messageId,
  // channelId}. Created and pinned once, then edited in place across sessions.
  // Deliberately CONFIG, not SESSION: outliving the session is the point.
  PINNED_STATUS_PREFIX: `${SSM_PREFIX}/pinned-status`,

  // --- SESSION (transient; cleared on stop) ---
  PLAYER_COUNT: `${SSM_PREFIX}/player-count`, // current online count, written by the host monitor each cycle
  JOIN_CODE: `${SSM_PREFIX}/join-code`, // per-session lobby code scraped by the host monitor ('none' = absent)
  SERVER_LIVE: `${SSM_PREFIX}/server-live`, // 'true' while the game answers the host monitor's liveness checks
  BOOT_PHASE: `${SSM_PREFIX}/boot-phase`, // JSON {id,label,emoji,progress,failure,at} of the pre-live stage; 'none' once live
  SESSION_STARTER: `${SSM_PREFIX}/session-starter`, // Discord user id that ran /<cmd> start ('none' = unknown, 'here' = scheduled opening -> @here)
  SESSION_PRIVATE: `${SSM_PREFIX}/session-private`, // 'true' for a quiet session: host skips the public online ping, join/status reply privately
  STATUS_MESSAGE_ID: `${SSM_PREFIX}/status-message-id`, // id of this session's readiness message; the offline notification edits it in place ('none' = post fresh)
  EXTEND_UNTIL: `${SSM_PREFIX}/extend-until`, // epoch-ms the host monitor holds off idle-shutdown until ('0'/absent = no grace)

  // --- CONFIG namespaces (a key per sub-entry, built by the helpers below) ---
  // Per-category notification toggles: /gatekeeper/<game>/notify/<category> = on|off
  NOTIFY_PREFIX: `${SSM_PREFIX}/notify`,
  // Per-Discord-server default world: /gatekeeper/<game>/discord/<guild-id>/default-world
  GUILD_DEFAULT_WORLD_PREFIX: `${SSM_PREFIX}/discord`,
} as const;

/**
 * The SESSION parameters and the value each is reset to on stop. The offline
 * Lambda (and, as a catch-all, the host stop paths) write these so a later
 * start is never mistaken for the previous session — e.g. a stale join code or a
 * leftover private flag. Single source so "what is session state" can't drift
 * from "what gets cleared".
 */
export const SESSION_PARAM_RESETS: ReadonlyArray<readonly [string, string]> = [
  [SSM_PARAMS.JOIN_CODE, "none"],
  [SSM_PARAMS.SERVER_LIVE, "false"],
  [SSM_PARAMS.BOOT_PHASE, "none"],
  [SSM_PARAMS.SESSION_STARTER, "none"],
  [SSM_PARAMS.SESSION_PRIVATE, "false"],
  [SSM_PARAMS.STATUS_MESSAGE_ID, "none"],
  [SSM_PARAMS.EXTEND_UNTIL, "0"],
];

/** SSM path for a notification category's on/off toggle. */
export function getNotifyParam(category: string): string {
  return `${SSM_PARAMS.NOTIFY_PREFIX}/${category}`;
}

/**
 * SSM path for a guild's durable pinned status message ({messageId, channelId}).
 * Absent means "not set up yet" — the host creates and pins one on next boot.
 */
export function getPinnedStatusParam(guildId: string): string {
  return `${SSM_PARAMS.PINNED_STATUS_PREFIX}/${guildId}`;
}

/** SSM path for a guild's default world. */
export function getGuildDefaultWorldParam(guildId: string): string {
  return `${SSM_PARAMS.GUILD_DEFAULT_WORLD_PREFIX}/${guildId}/default-world`;
}

/** Fixed lifecycle notification categories every game has. */
export const SYSTEM_NOTIFY_CATEGORIES = [
  { key: "online", label: "🟢 Server online / ready" },
  { key: "idle", label: "💤 Idle-shutdown notice" },
  { key: "backup", label: "💾 Backup complete" },
  { key: "failed", label: "⚠️ Failed to start" },
  { key: "boot", label: "⏳ Boot progress (updating / loading)" },
] as const;

/**
 * Every notification category for the active game: the system ones plus one per
 * distinct event category the profile defines (e.g. deaths, raids, joins). The
 * source of truth for both `/<cmd> notify` validation/listing and the registered
 * command's choices.
 */
export function notifyCategories(): { key: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const { key, label } of SYSTEM_NOTIFY_CATEGORIES) seen.set(key, label);
  for (const e of ACTIVE_GAME.events ?? []) {
    const cat = e.category ?? e.id;
    if (!seen.has(cat)) seen.set(cat, e.label ?? cat);
  }
  return [...seen].map(([key, label]) => ({ key, label }));
}

// ---------------------------------------------------------------------------
// Generic typed read/write helpers. Reads are best-effort: a missing parameter
// or any SSM error yields undefined (callers supply the default) — never throws,
// so a wiped param can't take down a Discord reply.
// ---------------------------------------------------------------------------

/** Raw string value of a parameter, or undefined if absent/unreadable. */
export async function getRawParam(
  name: string,
  opts: { decrypt?: boolean } = {},
): Promise<string | undefined> {
  try {
    const r = await ssmClient.send(
      new GetParameterCommand({ Name: name, WithDecryption: opts.decrypt }),
    );
    return r.Parameter?.Value ?? undefined;
  } catch {
    return undefined;
  }
}

/** Write a string parameter (overwriting). SecureString when secure=true. */
export async function putParam(
  name: string,
  value: string,
  opts: { secure?: boolean } = {},
): Promise<void> {
  await ssmClient.send(
    new PutParameterCommand({
      Name: name,
      Value: value,
      Type: opts.secure ? "SecureString" : "String",
      Overwrite: true,
    }),
  );
}

/**
 * Parse a JSON-valued parameter. Returns undefined when absent or when the value
 * isn't valid JSON (logged) — so a corrupt param degrades gracefully instead of
 * throwing mid-handler. Pass a validate fn to additionally reject bad shapes.
 */
export async function getJsonParam<T>(
  name: string,
  validate?: (value: unknown) => value is T,
): Promise<T | undefined> {
  const raw = await getRawParam(name);
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`SSM param ${name} is not valid JSON:`, err);
    return undefined;
  }
  if (validate && !validate(parsed)) {
    console.error(`SSM param ${name} failed validation`);
    return undefined;
  }
  return parsed as T;
}

/**
 * A positive-integer config value with a fallback. Returns 'off' (when allowed)
 * for the disabled sentinels so callers can suppress a feature; any unset,
 * non-numeric, or non-positive value falls back.
 */
export async function getNumberParam(
  name: string,
  fallback: number,
): Promise<number>;
export async function getNumberParam(
  name: string,
  fallback: number | "off",
  allowOff: true,
): Promise<number | "off">;
export async function getNumberParam(
  name: string,
  fallback: number | "off",
  allowOff = false,
): Promise<number | "off"> {
  const v = await getRawParam(name);
  if (allowOff && (v === "off" || v === "disabled")) return "off";
  const n = parseInt(v ?? "", 10);
  if (Number.isFinite(n) && n > 0) return n;
  return fallback;
}

// ---------------------------------------------------------------------------
// Domain accessors — the meaning of each parameter, in one place.
// ---------------------------------------------------------------------------

/**
 * Whether the game itself is up, as opposed to just the EC2 instance: the host
 * monitor writes 'true'/'false' on liveness transitions and 'false' at session
 * start/stop. A missing parameter counts as live so sessions predating the flag
 * (or a wiped param) never suppress join info.
 */
export async function getServerLive(): Promise<boolean> {
  return (await getRawParam(SSM_PARAMS.SERVER_LIVE)) !== "false";
}

/** What the host monitor last reported the pre-live boot was doing (see BootPhase). */
export interface BootPhaseStatus {
  id: string;
  label: string;
  emoji: string;
  /** 0-100 for phases that expose one (e.g. a SteamCMD download); absent otherwise. */
  progress?: number;
  /** True when the boot cannot succeed — surfaced as an error, not a "please wait". */
  failure: boolean;
  /** Epoch seconds this phase was first observed, for "… for 4m" rendering. */
  at?: number;
}

/**
 * The current pre-live boot stage, or null when there is none to report (server
 * already live, phase unset, or a profile without bootPhases). Best-effort by
 * design: a missing/garbled value degrades to the generic "Starting…" copy
 * rather than failing the status command.
 */
export async function getBootPhase(): Promise<BootPhaseStatus | null> {
  const raw = await getRawParam(SSM_PARAMS.BOOT_PHASE);
  if (!raw || raw === "none") return null;
  try {
    const p = JSON.parse(raw);
    if (!p?.id || !p?.label) return null;
    return {
      id: String(p.id),
      label: String(p.label),
      emoji: String(p.emoji || "⏳"),
      progress: typeof p.progress === "number" ? p.progress : undefined,
      failure: p.failure === true,
      at: typeof p.at === "number" ? p.at : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Whether the current session is private (quiet): started with `/<cmd> start
 * private`. The host then skips the public "Server Online" broadcast, and
 * join|status reply ephemerally. Set per-start (a normal start resets it) and
 * flipped off by `/<cmd> open`. Absent/anything-but-'true' counts as public —
 * the safe default (never accidentally hides a public game).
 */
export async function getSessionPrivate(): Promise<boolean> {
  return (await getRawParam(SSM_PARAMS.SESSION_PRIVATE)) === "true";
}

/**
 * Minutes of idle grace the Extend button grants per press. Per-game default
 * (seeded at deploy, retunable via `/<cmd> config set extend`); falls back to 5.
 * Returns 'off' when disabled so callers can suppress the button.
 */
export async function getExtendMinutes(): Promise<number | "off"> {
  return getNumberParam(SSM_PARAMS.EXTEND_MINUTES, 5, true);
}

/** Auto-delete TTL in hours for the status message (0 = off/unset → keep forever). */
export async function getMessageTtlHours(): Promise<number> {
  const v = await getNumberParam(SSM_PARAMS.MESSAGE_TTL_HOURS, 0, true);
  return v === "off" ? 0 : v;
}

/** Current online player count as written by the host monitor (0 if unset). */
export async function getPlayerCount(): Promise<number> {
  return getNumberParam(SSM_PARAMS.PLAYER_COUNT, 0);
}

/** This session's join/lobby code, or undefined when absent ('none'). */
export async function getJoinCode(): Promise<string | undefined> {
  const v = await getRawParam(SSM_PARAMS.JOIN_CODE);
  return v && v !== "none" ? v : undefined;
}

/**
 * The id of this session's readiness ("Server Online") message, or undefined
 * when nothing was posted ('none'/absent — private session or the online notice
 * was off). The offline Lambda edits this message into the offline state.
 */
export async function getStatusMessageId(): Promise<string | undefined> {
  const v = await getRawParam(SSM_PARAMS.STATUS_MESSAGE_ID);
  return v && v !== "none" ? v : undefined;
}

/** The loaded world (parsed WorldConfig), or undefined if unset/corrupt. */
export async function getActiveWorld(): Promise<WorldConfig | undefined> {
  return getJsonParam<WorldConfig>(SSM_PARAMS.ACTIVE_WORLD);
}

/** The loaded world's display name (its constant status-message title). */
export async function getActiveWorldName(): Promise<string | undefined> {
  const w = await getActiveWorld();
  return w?.name || w?.worldName || undefined;
}

/** The loaded world's Discord guild id (used to resolve the webhook). */
export async function getActiveGuildId(): Promise<string | undefined> {
  return (await getActiveWorld())?.discordServerId || undefined;
}

/** The configured webhook URL for a guild, or undefined if none is set up. */
export async function getWebhookForGuild(
  guildId: string,
): Promise<string | undefined> {
  return getRawParam(`${SSM_PARAMS.DISCORD_WEBHOOK}/${guildId}`, {
    decrypt: true,
  });
}

/**
 * Clear all SESSION parameters back to their idle defaults. The offline Lambda
 * calls this on EVERY stop (idle, /<cmd> stop, crash, console) as the
 * invalidation catch-all, so the next boot starts clean. Best-effort per key.
 */
export async function invalidateSessionParams(): Promise<void> {
  for (const [name, value] of SESSION_PARAM_RESETS) {
    try {
      await putParam(name, value);
    } catch (err) {
      console.error(`Failed to invalidate ${name}:`, err);
    }
  }
}
