import { APIGatewayProxyResult } from "aws-lambda";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { s3Client, BACKUP_BUCKET_NAME } from "../utils/aws-clients";
import { ACTIVE_GAME } from "../../games";
import {
  WORLD_CONFIGS,
  WorldConfig,
  getDefaultWorldConfig,
} from "../utils/world-config";
import { persona, personaEmbed } from "./util/persona";
import { InteractionResponseType } from "./types";

/**
 * /gate mods [world] — the world's mod list, with portal links from the S3
 * library metadata. For games where clients must mirror the server's mods
 * (e.g. Abiotic Factor — no server->client sync), this doubles as the
 * install list players follow before joining.
 */

interface ModMetadata {
  name?: string;
  kind?: string;
  version?: string;
  sourceUrl?: string;
}

async function fetchModMetadata(modName: string): Promise<ModMetadata | undefined> {
  try {
    const res = await s3Client.send(new GetObjectCommand({
      Bucket: BACKUP_BUCKET_NAME,
      Key: `mods/${modName}/metadata.json`,
    }));
    const body = await res.Body?.transformToString();
    return body ? (JSON.parse(body) as ModMetadata) : undefined;
  } catch (err) {
    console.warn(`No library metadata for mod '${modName}':`, err);
    return undefined;
  }
}

function respond(embed: Record<string, unknown>): APIGatewayProxyResult {
  return {
    statusCode: 200,
    body: JSON.stringify({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { embeds: [embed] },
    }),
  };
}

export async function handleModsCommand(
  worldName?: string,
  guildId?: string,
): Promise<APIGatewayProxyResult> {
  try {
    const spec = ACTIVE_GAME.mods;
    if (!spec) {
      return respond(personaEmbed({
        title: "🧩 Mods",
        description: `**${ACTIVE_GAME.displayName}** has no supported mod mechanism.`,
      }));
    }

    let world: WorldConfig | undefined;
    if (worldName) {
      world = WORLD_CONFIGS.find((w) =>
        w.name.toLowerCase() === worldName.toLowerCase() ||
        w.worldName.toLowerCase() === worldName.toLowerCase());
      if (!world) {
        return respond(personaEmbed({
          title: "🧩 Mods",
          description: `❌ World "${worldName}" not found.`,
          color: 0xff0000,
        }));
      }
    } else {
      world = getDefaultWorldConfig(guildId);
    }
    if (!world) {
      return respond(personaEmbed({
        title: "🧩 Mods",
        description: "❌ No worlds are configured.",
        color: 0xff0000,
      }));
    }

    const mods = world.mods ?? [];
    if (mods.length === 0) {
      return respond(personaEmbed({
        title: `🧩 Mods — ${world.name}`,
        description: `**${world.name}** runs vanilla ${ACTIVE_GAME.displayName} — no mods configured.`,
      }));
    }

    const metas = await Promise.all(mods.map(fetchModMetadata));
    const lines = mods.map((name, i) => {
      const meta = metas[i];
      const version = meta?.version ? ` v${meta.version}` : "";
      const label = `**${name}**${version}`;
      const detail = meta?.sourceUrl
        ? `[mod page](${meta.sourceUrl})`
        : meta?.kind ?? "not in the mod library ⚠️";
      return `• ${label} — ${detail}`;
    });

    const matchWarning = spec.clientsMustMatch
      ? "\n\n⚠️ **Install these same mods on your own game before joining** — " +
        `${ACTIVE_GAME.displayName} doesn't sync mods to clients, and mismatches desync or crash.`
      : "";

    return respond(personaEmbed({
      title: `🧩 Mods — ${world.name}`,
      description: lines.join("\n") + matchWarning,
      footerSuffix: `${mods.length} mod(s) • ${persona.footer}`,
    }));
  } catch (error) {
    console.error("Error in handleModsCommand:", error);
    return respond(personaEmbed({
      title: "❌ Mods",
      description: "Couldn't read the mod list right now. Please try again.",
      color: 0xff0000,
    }));
  }
}
