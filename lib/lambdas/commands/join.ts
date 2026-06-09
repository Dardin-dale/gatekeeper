import { APIGatewayProxyResult } from "aws-lambda";
import { InteractionResponseType } from "./types";
import { ACTIVE_GAME, gameDomain } from "../../games";
import { personaEmbed } from "./util/persona";

/**
 * /gate join — how to connect. For address-based games (Abiotic Factor) returns
 * <derived domain or public IP>:<port>. For join-code games it points players at the
 * code that gets posted when the server is ready.
 */
export async function handleJoinCommand(): Promise<APIGatewayProxyResult> {
  const join = ACTIVE_GAME.join;
  let description: string;

  if (join.type === "address") {
    const host = gameDomain(); // <subdomain>.<BASE_DOMAIN>, if a base domain is set
    description = host
      ? `Connect in-game to:\n\`${host}:${join.port}\``
      : `Once the server is running, connect to its public IP on port \`${join.port}\`. ` +
        `Use \`/gate status\` to get the address, or set BASE_DOMAIN for a stable one.`;
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
