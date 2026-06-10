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

/** Standard embed footer, e.g. "GATEKeeper • GATE Cascade Research Facility". */
export function personaFooter(suffix: string = persona.footer): string {
  return `${persona.botName} • ${suffix}`;
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

/** Build a persona-styled embed, bylined to the character + hologram thumbnail. */
export function personaEmbed(fields: {
  title: string;
  description?: string;
  color?: number;
  footerSuffix?: string;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  const embed: Record<string, unknown> = {
    author: personaAuthor(),
    title: fields.title,
    color: fields.color ?? persona.color,
    footer: { text: personaFooter(fields.footerSuffix) },
    ...fields.extra,
  };
  if (fields.description) embed.description = fields.description;
  if (persona.thumbnailUrl) embed.thumbnail = { url: persona.thumbnailUrl };
  return embed;
}
