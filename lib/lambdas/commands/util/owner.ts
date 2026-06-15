import { APIGatewayProxyResult } from "aws-lambda";
import { InteractionResponseType } from "../types";

/**
 * Bot-owner authorization for spend-affecting commands.
 *
 * The bot is multi-guild (worlds carry different discordServerId), so a guild
 * permission (Administrator/Manage Server) is the wrong gate — a guild admin in
 * someone else's server shouldn't be able to spend the OWNER's AWS money. The
 * owner is therefore an explicit Discord-user-id allowlist, seeded per-deploy
 * via the BOT_OWNER_IDS env var (comma-separated), NOT a guild role.
 *
 * Fails CLOSED: an empty/unset allowlist denies everyone, so a misconfigured
 * deploy can never silently open the spend controls to the whole server.
 */
export function ownerIds(): string[] {
  return (process.env.BOT_OWNER_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The invoking user's id — `member.user.id` in a guild, `user.id` in a DM. */
export function callerId(interaction: any): string | undefined {
  return interaction?.member?.user?.id ?? interaction?.user?.id;
}

export function isOwner(interaction: any): boolean {
  const ids = ownerIds();
  if (ids.length === 0) return false; // fail closed
  const id = callerId(interaction);
  return !!id && ids.includes(id);
}

/**
 * Gate a handler on owner identity. Returns an EPHEMERAL (flags 64) denial
 * response when the caller isn't an owner, or null when they are — so the call
 * site reads `const denied = requireOwner(body); if (denied) return denied;`.
 * Ephemeral so a public channel never shows the rejection (or who tried).
 */
export function requireOwner(interaction: any): APIGatewayProxyResult | null {
  if (isOwner(interaction)) return null;
  // Show the caller their own numeric id (ephemeral, so only they see it) — the
  // self-service way to get whitelisted into BOT_OWNER_IDS without hunting for it
  // in Discord's shifting Developer-Mode UI.
  const id = callerId(interaction);
  const idLine = id ? `\nYour Discord user ID is \`${id}\` — the owner can add it to BOT_OWNER_IDS.` : "";
  return {
    statusCode: 200,
    body: JSON.stringify({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: `🔒 Only the bot owner can change cost-affecting settings.${idLine}`,
        flags: 64, // ephemeral — private to the caller
      },
    }),
  };
}
