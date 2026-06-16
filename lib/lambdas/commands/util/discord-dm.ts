/**
 * Send a Discord DM from the bot. Used for owner-only out-of-band pings (e.g.
 * "a private session is starting") that shouldn't touch any channel.
 *
 * Best-effort: a DM silently fails if the recipient blocks DMs from server
 * members, so callers must NOT depend on delivery — it's a courtesy ping, not a
 * source of truth. Returns whether the message posted.
 */
const DISCORD_API = "https://discord.com/api/v10";

export async function dmUser(userId: string, message: Record<string, unknown>): Promise<boolean> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token || !userId) return false;
  const headers = { "Content-Type": "application/json", Authorization: `Bot ${token}` };
  try {
    // Open (or reuse) the 1:1 DM channel with this user.
    const chRes = await fetch(`${DISCORD_API}/users/@me/channels`, {
      method: "POST",
      headers,
      body: JSON.stringify({ recipient_id: userId }),
    });
    if (!chRes.ok) return false;
    const channel = await chRes.json();
    const msgRes = await fetch(`${DISCORD_API}/channels/${channel.id}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
    });
    return msgRes.ok;
  } catch (err) {
    console.error(`Failed to DM user ${userId}:`, err);
    return false;
  }
}

/** DM every owner in `ownerIds`, skipping `exceptUserId` (e.g. the caller who already saw a reply). */
export async function dmOwners(
  ownerIds: string[],
  exceptUserId: string | undefined,
  message: Record<string, unknown>,
): Promise<void> {
  await Promise.all(
    ownerIds.filter((id) => id !== exceptUserId).map((id) => dmUser(id, message)),
  );
}
