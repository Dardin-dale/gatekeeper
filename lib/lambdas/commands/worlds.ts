import { APIGatewayProxyResult } from "aws-lambda";
import { GetParameterCommand } from "@aws-sdk/client-ssm";
import { ssmClient } from "../utils/aws-clients";
import { getGuildDefaultWorldParam } from "../utils/params";
import { ACTIVE_GAME } from "../../games";
import { WORLD_CONFIGS, getDefaultWorldConfig } from "../utils/world-config";
import { personaEmbed, slash } from "./util/persona";
import { InteractionResponseType } from "./types";

/**
 * /gate worlds — the worlds this Discord server can start, so players know
 * what to pass to `/gate start [world]`. Configured in the gitignored
 * config/<game>.worlds.json; the ▶️ marker is what a bare `/gate start`
 * would load for this guild (its SSM default override, else the config default).
 */
export async function handleWorldsCommand(guildId?: string): Promise<APIGatewayProxyResult> {
  const respond = (embed: Record<string, unknown>): APIGatewayProxyResult => ({
    statusCode: 200,
    body: JSON.stringify({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { embeds: [embed] },
    }),
  });

  try {
    const guildWorlds = guildId
      ? WORLD_CONFIGS.filter((w) => w.discordServerId === guildId)
      : WORLD_CONFIGS;
    if (guildWorlds.length === 0) {
      return respond(personaEmbed({
        title: "🌍 Worlds",
        description:
          "No worlds are configured for this Discord server. " +
          `Add one to \`config/${ACTIVE_GAME.id}.worlds.json\` and redeploy.`,
        color: 0xffaa00,
      }));
    }

    // What a bare /gate start would load: the guild's SSM default override
    // (set via the setup flow), else the config-flagged default.
    let startName = getDefaultWorldConfig(guildId, guildWorlds)?.name;
    if (guildId) {
      try {
        const res = await ssmClient.send(new GetParameterCommand({
          Name: getGuildDefaultWorldParam(guildId),
        }));
        if (res.Parameter?.Value) {
          const override = guildWorlds.find((w) =>
            w.name.toLowerCase() === res.Parameter!.Value!.toLowerCase() ||
            w.worldName.toLowerCase() === res.Parameter!.Value!.toLowerCase());
          if (override) startName = override.name;
        }
      } catch {
        // no guild override set — config default stands
      }
    }

    const lines = guildWorlds.map((w) => {
      const marker = w.name === startName ? "▶️ " : "• ";
      const mods = w.mods?.length ? ` — 🧩 ${w.mods.length} mod(s)` : "";
      return `${marker}**${w.name}** (save: \`${w.worldName}\`)${mods}`;
    });

    return respond(personaEmbed({
      title: "🌍 Worlds",
      description:
        lines.join("\n") +
        `\n\n▶️ = what \`${slash} start\` loads here. Start another with ` +
        `\`${slash} start <world>\`; check a world's mods with \`${slash} mods <world>\`.`,
    }));
  } catch (error) {
    console.error("Error in handleWorldsCommand:", error);
    return respond(personaEmbed({
      title: "❌ Worlds",
      description: "Couldn't read the world list right now. Please try again.",
      color: 0xff0000,
    }));
  }
}
