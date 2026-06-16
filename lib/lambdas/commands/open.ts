import { APIGatewayProxyResult } from "aws-lambda";
import { GetParameterCommand, PutParameterCommand } from "@aws-sdk/client-ssm";
import {
  ssmClient,
  withRetry,
  SSM_PARAMS,
  getFastServerStatus,
  getServerLive,
  getSessionPrivate,
} from "../utils/aws-clients";
import { InteractionResponseType } from "./types";
import { persona, personaEmbed, personaAvatarUrl, slash } from "./util/persona";
import { buildJoinFields, joinHost, joinHint } from "./util/join-info";

/** Ephemeral reply (private to the caller) — the confirmation, not the public announcement. */
function ephemeral(title: string, description: string): APIGatewayProxyResult {
  return {
    statusCode: 200,
    body: JSON.stringify({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        embeds: [personaEmbed({ byline: false, title, description })],
        flags: 64,
      },
    }),
  };
}

/** Post the public "now open" announcement (join details) to the guild webhook. */
async function announce(guildId: string, host: string): Promise<boolean> {
  let webhookUrl: string | undefined;
  try {
    const r = await withRetry(() => ssmClient.send(new GetParameterCommand({
      Name: `${SSM_PARAMS.DISCORD_WEBHOOK}/${guildId}`,
      WithDecryption: true,
    })));
    webhookUrl = r.Parameter?.Value;
  } catch {
    return false;
  }
  if (!webhookUrl) return false;

  const embed = personaEmbed({
    byline: false,
    withThumbnail: true,
    title: "🟢 Server Now Open",
    description: joinHint() ?? `Connect in-game to \`${host}\``,
    color: 0x39a0a0,
    extra: { fields: await buildJoinFields(host) },
  });
  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: persona.characterName,
      ...(personaAvatarUrl ? { avatar_url: personaAvatarUrl } : {}),
      embeds: [embed],
    }),
  });
  return true;
}

/**
 * `/<cmd> open` — flip a private session public: clear the private flag and
 * announce the join details to the channel so everyone can join.
 *
 * Timing-aware so the announcement posts exactly once:
 *  - server already live → the host already SKIPPED its readiness ping (private),
 *    so this command posts the public join embed itself.
 *  - still booting → just clear the flag; the host's normal readiness ping fires
 *    publicly when the game comes live (no lambda post, no double-announce).
 */
export async function handleOpenCommand(guildId?: string): Promise<APIGatewayProxyResult> {
  try {
    const { status, publicIp } = await getFastServerStatus();
    if (status !== "running") {
      return ephemeral("🔓 Nothing to open", `The server isn't running (status: ${status}).`);
    }
    if (!(await getSessionPrivate())) {
      return ephemeral("🔓 Already public", "This session is already open — join details are posted in the channel.");
    }

    // Flip to public first, so a readiness ping racing in (still-booting case)
    // sees 'false' and announces normally.
    await withRetry(() => ssmClient.send(new PutParameterCommand({
      Name: SSM_PARAMS.SESSION_PRIVATE,
      Value: "false",
      Type: "String",
      Overwrite: true,
    })));

    const live = await getServerLive();
    const host = joinHost(publicIp);
    if (live && host) {
      const posted = await announce(guildId ?? "", host);
      return ephemeral(
        "🔓 Session Opened",
        posted
          ? "Announced to the channel — everyone can join now."
          : `Opened up, but no channel webhook is configured. Players can use \`${slash} join\`.`,
      );
    }
    // Still booting: the host posts the public readiness ping when it comes live.
    return ephemeral("🔓 Session Opened", "It'll be announced to the channel as soon as the server is live.");
  } catch (error) {
    console.error("Error in handleOpenCommand:", error);
    return ephemeral("❌ Couldn't open the session", "Please try again in a moment.");
  }
}
