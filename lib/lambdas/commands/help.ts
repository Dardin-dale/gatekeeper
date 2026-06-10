import { APIGatewayProxyResult } from "aws-lambda";
import { InteractionResponseType } from "./types";
import { ACTIVE_GAME } from "../../games";
import { persona, personaEmbed } from "./util/persona";

/**
 * /gate help — lists the actual `/gate` subcommands, themed to the active game's
 * persona. No hardcoded game/bot names: everything reads from ACTIVE_GAME.
 */
export async function handleHelpCommand(): Promise<APIGatewayProxyResult> {
  const game = ACTIVE_GAME.displayName;
  const embed = personaEmbed({
    title: `📚 ${persona.botName} Help`,
    description: `${persona.botName} manages your **${game}** server from Discord.`,
    color: 0x5865f2,
    extra: {
      fields: [
        {
          name: "Server",
          value: [
            "`/gate start [world]` — start the server",
            "`/gate stop [force]` — stop the server (force skips the backup)",
            "`/gate status` — current status, world, players",
            "`/gate join` — how to connect",
            "`/gate worlds` — the worlds you can start here",
            "`/gate mods [world]` — a world's mod list (and what to install)",
          ].join("\n"),
        },
        {
          name: "Setup & Fun",
          value: [
            "`/gate setup` — wire up notifications in this channel",
            `\`/gate hail\` — a transmission from ${persona.characterName}`,
            "`/gate help` — show this menu",
          ].join("\n"),
        },
        {
          name: "Getting Started",
          value:
            "1. `/gate setup` to configure notifications\n" +
            "2. `/gate start` to launch the server\n" +
            "3. You'll get a ping with the join address when it's live",
        },
      ],
    },
  });

  return {
    statusCode: 200,
    body: JSON.stringify({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { embeds: [embed] },
    }),
  };
}
