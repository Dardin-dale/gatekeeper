import { APIGatewayProxyResult } from "aws-lambda";
import { InteractionResponseType } from "./types";
import { persona, pickHailQuote, personaEmbed } from "./util/persona";

/**
 * /gate hail — the ping test. Returns an in-character line for the active game's
 * persona (a recorded Dr. Derek Manse hologram for Abiotic Factor).
 */
export async function handleHailCommand(): Promise<APIGatewayProxyResult> {
  const embed = personaEmbed({
    title: `📽️ Hologram: ${persona.characterName}`,
    description: pickHailQuote(),
    withThumbnail: true, // the showpiece — full character portrait
  });

  return {
    statusCode: 200,
    body: JSON.stringify({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { embeds: [embed] },
    }),
  };
}
