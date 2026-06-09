import { APIGatewayProxyResult } from "aws-lambda";
import { InteractionResponseType } from "./types";
import { ACTIVE_GAME, gameDomain } from "../../games";
import { getFastServerStatus } from "../utils/aws-clients";
import { personaEmbed } from "./util/persona";

/**
 * /gate join — how to connect. The join strategy is game-dependent and comes
 * from the profile's `join` discriminated union:
 *   - { type: 'address', port }   (Abiotic Factor): return
 *     <derived domain ?? instance public IP>:<port>
 *   - { type: 'join-code', ... }  (Valheim-style): the code is detected on-host
 *     and posted to the channel; this command just points players there.
 */
export async function handleJoinCommand(): Promise<APIGatewayProxyResult> {
  const join = ACTIVE_GAME.join;
  let description: string;

  if (join.type === "address") {
    const { status, publicIp } = await getFastServerStatus();
    if (status !== "running") {
      description = `The server is not running (status: ${status}). ` +
        `Start it with \`/gate start\` — the join address is posted here when it's ready.`;
    } else {
      // Prefer the stable derived domain; fall back to the current public IP.
      const host = gameDomain() ?? publicIp;
      description = host
        ? `Connect in-game to:\n\`${host}:${join.port}\``
        : `The server is starting but has no public address yet — try again in a moment.`;
    }
  } else {
    description = "This game uses a join code — it's posted to this channel when the server is ready.";
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        embeds: [personaEmbed({ title: "🔌 Join the server", description })],
      },
    }),
  };
}
