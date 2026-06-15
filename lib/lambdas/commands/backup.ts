import { APIGatewayProxyResult } from "aws-lambda";
import { SendCommandCommand } from "@aws-sdk/client-ssm";
import {
  ssmClient,
  withRetry,
  SERVER_INSTANCE_ID,
  getFastServerStatus,
} from "../utils/aws-clients";
import { InteractionResponseType } from "./types";
import { persona, personaFooter, slash } from "./util/persona";

/** Wrap an embed in the standard interaction response shape. */
function embed(title: string, description: string, color: number, footerSuffix?: string): APIGatewayProxyResult {
  return {
    statusCode: 200,
    body: JSON.stringify({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        embeds: [{
          title,
          description,
          color,
          footer: { text: footerSuffix ? personaFooter(footerSuffix) : persona.botName },
        }],
      },
    }),
  };
}

/**
 * `/gate backup` — archive the current world WITHOUT stopping the server. Mirrors
 * the backup half of `/gate stop`: the on-host backup-server.sh is fired via SSM
 * (fire-and-forget); it posts its own "Backup Complete" webhook when done.
 */
export async function handleBackupCommand(): Promise<APIGatewayProxyResult> {
  try {
    const { status } = await getFastServerStatus();
    console.log(`Manual backup requested; instance status: ${status}`);

    if (status !== "running") {
      // backup-server.sh runs on the live host (it archives the running
      // container's save), so a stopped/booting box can't be backed up on
      // demand. A stopped world is already safe on the RETAIN'd EBS volume.
      const desc = status === "stopped"
        ? "The server is stopped — its world data is already safe on the persistent volume. " +
          `Start it with ${slash} start if you want a fresh archive now.`
        : `The server is **${status}**. Wait until it is fully running, then try again.`;
      return embed("💾 Nothing to Back Up Yet", desc, 0xffaa00, `Use ${slash} start to launch the server`);
    }

    await withRetry(() => ssmClient.send(new SendCommandCommand({
      DocumentName: "AWS-RunShellScript",
      InstanceIds: [SERVER_INSTANCE_ID],
      Parameters: { commands: ["/usr/local/bin/backup-server.sh"] },
      Comment: "Manual backup triggered via Discord backup command",
    })));
    console.log("backup-server.sh triggered (running in background)");

    return embed(
      "💾 Backup Started",
      "Archiving the current world to the backup bucket. **The server stays up** — keep playing. " +
        "A confirmation is posted here when the archive completes.",
      persona.color,
    );
  } catch (error) {
    console.error("Error in handleBackupCommand:", error);
    return embed(
      "❌ Backup Failed",
      "Unable to trigger a backup right now. Please try again in a moment.",
      0xff0000,
      "Contact admin if this persists",
    );
  }
}
