import { APIGatewayProxyResult } from "aws-lambda";
import { InteractionResponseType } from "./types";
import { ACTIVE_GAME } from "../../games";
import { persona, personaEmbed, slash } from "./util/persona";

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
            `\`${slash} start [world]\` — start the server`,
            `\`${slash} stop [force]\` — stop the server (force skips the backup)`,
            `\`${slash} status\` — current status, world, players`,
            `\`${slash} backup\` — back up the world now (server keeps running)`,
            `\`${slash} join\` — how to connect`,
            `\`${slash} worlds\` — the worlds you can start here`,
            `\`${slash} mods [world]\` — a world's mod list (and what to install)`,
            `\`${slash} schedule set|clear|list\` — schedule an opening (pre-warms on time)`,
          ].join("\n"),
        },
        {
          name: "Setup & Fun",
          value: [
            `\`${slash} setup\` — wire up notifications in this channel`,
            `\`${slash} hail\` — a transmission from ${persona.characterName}`,
            `\`${slash} help\` — show this menu`,
          ].join("\n"),
        },
        {
          name: "Getting Started",
          value:
            `1. \`${slash} setup\` to configure notifications\n` +
            `2. \`${slash} start\` to launch the server\n` +
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
