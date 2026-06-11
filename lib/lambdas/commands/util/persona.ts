import { ACTIVE_GAME } from "../../../games";

/**
 * Persona helpers — the bot's voice/branding for the active game profile.
 * Lets command handlers build on-theme embeds without hardcoding game-specific
 * strings. Driven by GameProfile.persona (e.g. Dr. Derek Manse for Abiotic Factor).
 */
export const persona = ACTIVE_GAME.persona;

/**
 * The active game's top-level slash command, with the slash: '/gate', '/munin'.
 * User-facing strings must use this (never a literal '/gate') so every profile's
 * messages reference its own command.
 */
export const slash = `/${ACTIVE_GAME.commandName}`;

/** A random first-person line for the /gate hail ping. */
export function pickHailQuote(): string {
  const quotes = persona.hailQuotes;
  return quotes[Math.floor(Math.random() * quotes.length)];
}

/**
 * Random pick from an optional persona line pool (e.g. lines.scheduled,
 * lines.countdown), falling back to a neutral default for profiles that
 * haven't written flavor for that moment yet.
 */
export function pickLine(pool: string[] | undefined, fallback: string): string {
  if (!pool || pool.length === 0) return fallback;
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * Standard embed footer. Just the suffix (default: the persona's flavor
 * footer) — the bot's name/avatar already head every message via its Discord
 * app theming, so repeating botName here was pure duplication.
 */
export function personaFooter(suffix: string = persona.footer): string {
  return suffix;
}

/**
 * The character byline for embeds + webhook posts, so every message reads as
 * coming from the persona in full (e.g. "Dr. Derek Manse" for Abiotic Factor),
 * matching how he's credited in-game. Includes his hologram as the icon when set.
 */
export function personaAuthor(): Record<string, unknown> {
  const author: Record<string, unknown> = { name: persona.characterName };
  if (persona.thumbnailUrl) author.icon_url = persona.thumbnailUrl;
  return author;
}

/**
 * Build a persona-styled embed. Identity is layered, not repeated:
 *  - The Discord app (bot name/avatar from the portal) heads every interaction
 *    response, so embeds don't restate it.
 *  - `byline` (default on) adds the CHARACTER's voice (e.g. Dr. Manse) — kept
 *    for bot responses because the character is distinct from the bot identity;
 *    turn it OFF for webhook posts that already set username/avatar_url to the
 *    character at the message level.
 *  - `withThumbnail` (default off) adds the big character image — reserved for
 *    showpieces like /gate hail.
 */
export function personaEmbed(fields: {
  title: string;
  description?: string;
  color?: number;
  footerSuffix?: string;
  byline?: boolean;
  withThumbnail?: boolean;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  const embed: Record<string, unknown> = {
    title: fields.title,
    color: fields.color ?? persona.color,
    footer: { text: personaFooter(fields.footerSuffix) },
    ...fields.extra,
  };
  if (fields.byline !== false) embed.author = personaAuthor();
  if (fields.description) embed.description = fields.description;
  if (fields.withThumbnail && persona.thumbnailUrl) embed.thumbnail = { url: persona.thumbnailUrl };
  return embed;
}
