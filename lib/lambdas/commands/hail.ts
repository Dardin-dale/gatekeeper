import { APIGatewayProxyResult } from "aws-lambda";
import { InteractionResponseType } from "./types";
import { persona, pickHailQuote, personaEmbed } from "./util/persona";

/**
 * /gate hail — the ping test. Returns an in-character line for the active game's
 * persona. The title is just the character: any game-flavored framing (e.g.
 * "Hologram:" for AF's Manse) belongs in the persona's own quotes, not here.
 */
export async function handleHailCommand(): Promise<APIGatewayProxyResult> {
  const embed = personaEmbed({
    title: persona.characterName,
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
