import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Context,
} from "aws-lambda";

import { SERVER_INSTANCE_ID } from "./utils/aws-clients";
import { ACTIVE_GAME } from "../games";
import { InteractionType, InteractionResponseType } from "./commands/types";
import { handleStartCommand } from "./commands/start";
import { handleStopCommand } from "./commands/stop";
import { handleBackupCommand } from "./commands/backup";
import { handleNotifyCommand } from "./commands/notify";
import { handleConfigCommand } from "./commands/config";
import { handleStatusCommand } from "./commands/status";
import { handleJoinCommand } from "./commands/join";
import { handleOpenCommand } from "./commands/open";
import { handleModsCommand } from "./commands/mods";
import { handleWorldsCommand } from "./commands/worlds";
import { handleHailCommand } from "./commands/hail";
import { handleHelpCommand } from "./commands/help";
import { handleSetupCommand } from "./commands/setup";
import { handleScheduleCommand } from "./commands/schedule";
import { handleComponentInteraction } from "./commands/component";

const { verifyKey } = require("discord-interactions");

export async function handler(
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> {
  // Keep Lambda alive to complete async operations — required for deferred
  // Discord responses to deliver after the initial 3-second ACK.
  context.callbackWaitsForEmptyEventLoop = true;

  console.log("Event:", JSON.stringify(event, null, 2));

  try {
    const signature =
      event.headers["x-signature-ed25519"] ||
      event.headers["X-Signature-Ed25519"];
    const timestamp =
      event.headers["x-signature-timestamp"] ||
      event.headers["X-Signature-Timestamp"];
    const publicKey = process.env.DISCORD_BOT_PUBLIC_KEY;

    if (!signature || !timestamp || !publicKey) {
      console.error("Missing required headers for Discord verification");
      return {
        statusCode: 401,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Unauthorized" }),
      };
    }

    try {
      const isValidRequest = await verifyKey(
        event.body || "",
        signature,
        timestamp,
        publicKey,
      );
      if (!isValidRequest) {
        return {
          statusCode: 401,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: "Invalid request signature" }),
        };
      }
    } catch (error) {
      console.error("Error during signature verification:", error);
      return {
        statusCode: 401,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Signature verification failed" }),
      };
    }

    const body = JSON.parse(event.body || "{}");

    if (body.type === InteractionType.PING) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: InteractionResponseType.PONG }),
      };
    }

    if (body.type === InteractionType.APPLICATION_COMMAND) {
      const { data, guild_id } = body;
      const command = data.name;
      console.log(`Processing command: ${command}`);

      const cmd = ACTIVE_GAME.commandName; // e.g. 'gate' (AF), 'hugin' (Valheim)
      const unknown = {
        statusCode: 200,
        body: JSON.stringify({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `Unknown command. Use \`/${cmd} help\` to see available commands.` },
        }),
      };

      // All subcommands live under this game's top-level command; dispatch by subcommand.
      if (command !== cmd) return unknown;

      const sub = data.options?.[0];
      const subName: string | undefined = sub?.name;
      const subOptions: any[] | undefined = sub?.options;
      console.log(`Processing subcommand: ${cmd} ${subName}`);

      // These work without a deployed server.
      switch (subName) {
        case "hail":
          return await handleHailCommand();
        case "join": {
          const isPrivate = subOptions?.find((o: any) => o.name === "private")?.value || false;
          return await handleJoinCommand(isPrivate);
        }
        case "mods": {
          const worldName = subOptions?.find((o: any) => o.name === "world")?.value;
          return await handleModsCommand(worldName, guild_id);
        }
        case "worlds":
          return await handleWorldsCommand(guild_id);
        case "setup":
          return await handleSetupCommand(body);
        case "help":
          return await handleHelpCommand();
        case "notify": {
          // Subcommand group: the action (set|list) is options[0] of the group.
          const action = subOptions?.[0];
          return await handleNotifyCommand(action?.name, action?.options);
        }
        case "config": {
          // Owner-only spend timers. Subcommand group: action (show|set) is
          // options[0]; the interaction (body) carries the caller for the gate.
          const action = subOptions?.[0];
          return await handleConfigCommand(action?.name, action?.options, body);
        }
      }

      // The rest control the EC2 instance and need it to exist.
      if (!SERVER_INSTANCE_ID) {
        return {
          statusCode: 200,
          body: JSON.stringify({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: `❌ The server isn't deployed yet (no instance ID). Try \`/${cmd} hail\`.` },
          }),
        };
      }

      switch (subName) {
        case "start": {
          const worldName = subOptions?.find((o: any) => o.name === "world")?.value;
          const isPrivate = subOptions?.find((o: any) => o.name === "private")?.value || false;
          return await handleStartCommand(worldName, guild_id, isPrivate);
        }
        case "stop": {
          const force = subOptions?.find((o: any) => o.name === "force")?.value || false;
          return await handleStopCommand(guild_id, force);
        }
        case "status": {
          const isPrivate = subOptions?.find((o: any) => o.name === "private")?.value || false;
          return await handleStatusCommand(isPrivate);
        }
        case "open":
          return await handleOpenCommand(guild_id);
        case "backup":
          return await handleBackupCommand();
        case "schedule": {
          // Subcommand group: the actual action (set|clear|list) is one level
          // down — options[0] of the group, with its own options.
          const action = subOptions?.[0];
          return await handleScheduleCommand(action?.name, action?.options, guild_id);
        }
        default:
          return unknown;
      }
    }

    if (body.type === InteractionType.MESSAGE_COMPONENT) {
      return await handleComponentInteraction(body);
    }

    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Unhandled interaction type" }),
    };
  } catch (error) {
    console.error("Error:", error);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
}
