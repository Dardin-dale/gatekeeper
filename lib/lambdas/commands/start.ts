import { APIGatewayProxyResult } from "aws-lambda";
import {
  StartInstancesCommand,
  StopInstancesCommand,
} from "@aws-sdk/client-ec2";
import {
  GetParameterCommand,
  PutParameterCommand,
  DeleteParameterCommand,
  SendCommandCommand,
} from "@aws-sdk/client-ssm";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import {
  ec2Client,
  ssmClient,
  s3Client,
  withRetry,
  SERVER_INSTANCE_ID,
  BACKUP_BUCKET_NAME,
  SSM_PARAMS,
  getGuildDefaultWorldParam,
  getInstanceStatus,
  getStatusMessage,
  getFastServerStatus,
} from "../utils/aws-clients";
import {
  createSuccessResponse,
  createBadRequestResponse,
  createErrorResponse,
} from "../utils/responses";
import {
  WORLD_CONFIGS,
  WorldConfig,
  validateWorldConfig,
} from "../utils/world-config";
import { sendFollowUpMessage } from "../utils/discord-followup";
import { InteractionResponseType } from "./types";
import { persona, personaFooter, slash } from "./util/persona";
import { ACTIVE_GAME } from "../../games";
import { ownerIds, callerId } from "./util/owner";
import { dmOwners } from "./util/discord-dm";

export async function handleStartCommand(worldName?: string, guildId?: string, isPrivate = false, interaction?: any): Promise<APIGatewayProxyResult> {
  try {
    console.log(`Starting server command - worldName: ${worldName}, guildId: ${guildId}, private: ${isPrivate}`);

    // Check current status
    const { status } = await getFastServerStatus();
    console.log(`Current instance status: ${status}`);

    if (status === 'running') {
      return {
        statusCode: 200,
        body: JSON.stringify({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            embeds: [{
              title: '✅ Server Already Running',
              description: 'The server is already online!',
              color: 0x00ff00,
              footer: { text: personaFooter(`Use ${slash} status for details`) }
            }]
          }
        })
      };
    }

    if (status === 'pending') {
      return {
        statusCode: 200,
        body: JSON.stringify({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            embeds: [{
              title: '🚀 Server Already Starting',
              description: 'The server is currently booting up. Please wait a moment.',
              color: 0xffaa00,
              footer: { text: personaFooter("You'll be notified when it's live") }
            }]
          }
        })
      };
    }

    if (status === 'stopping') {
      return {
        statusCode: 200,
        body: JSON.stringify({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            embeds: [{
              title: '⏸️ Server is Shutting Down',
              description: 'The server is currently stopping. Please wait a moment for it to fully stop before starting again.',
              color: 0xffaa00,
              footer: { text: personaFooter('Try again in a moment') }
            }]
          }
        })
      };
    }

    // Handle world configuration
    let selectedWorldConfig: WorldConfig | undefined;

    if (worldName) {
      selectedWorldConfig = WORLD_CONFIGS.find(w =>
        w.name.toLowerCase() === worldName.toLowerCase() ||
        w.worldName.toLowerCase() === worldName.toLowerCase()
      );

      if (!selectedWorldConfig) {
        return {
          statusCode: 200,
          body: JSON.stringify({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: `❌ World "${worldName}" not found. Use ${slash} worlds to see available worlds.`
            }
          })
        };
      }
    } else if (guildId) {
      // Check for guild-specific default world in SSM first
      try {
        const guildDefaultParam = getGuildDefaultWorldParam(guildId);
        const guildDefaultResult = await ssmClient.send(new GetParameterCommand({
          Name: guildDefaultParam
        }));
        if (guildDefaultResult.Parameter?.Value) {
          const defaultWorldName = guildDefaultResult.Parameter.Value;
          console.log(`Found guild default world: ${defaultWorldName}`);
          selectedWorldConfig = WORLD_CONFIGS.find(w =>
            w.name.toLowerCase() === defaultWorldName.toLowerCase() ||
            w.worldName.toLowerCase() === defaultWorldName.toLowerCase()
          );
        }
      } catch (err) {
        // No guild default set, fall through to WORLD_CONFIGS filter
        console.log('No guild-specific default world set');
      }

      // Fall back to WORLD_CONFIGS filter if no SSM default
      if (!selectedWorldConfig) {
        const discordWorlds = WORLD_CONFIGS.filter(w => w.discordServerId === guildId);
        if (discordWorlds.length > 0) {
          selectedWorldConfig = discordWorlds[0];
        }
      }
    }

    if (selectedWorldConfig) {
      console.log(`Selected world: ${selectedWorldConfig.name} (${selectedWorldConfig.worldName})`);

      const validationErrors = validateWorldConfig(selectedWorldConfig);
      if (validationErrors.length > 0) {
        return {
          statusCode: 200,
          body: JSON.stringify({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: `❌ Invalid world configuration: ${validationErrors.join(', ')}`
            }
          })
        };
      }

      // Store active world configuration
      await withRetry(() =>
        ssmClient.send(new PutParameterCommand({
          Name: SSM_PARAMS.ACTIVE_WORLD,
          Value: JSON.stringify(selectedWorldConfig),
          Type: 'String',
          Overwrite: true
        }))
      );
      console.log(`Active world configuration saved`);
    }

    // Record the session's privacy up front (always set, so a normal start
    // resets a prior private session to public). The host reads this to decide
    // whether to post the public readiness ping; join/status read it to decide
    // whether to reply privately. `/<cmd> open` flips it back to 'false'.
    await withRetry(() =>
      ssmClient.send(new PutParameterCommand({
        Name: SSM_PARAMS.SESSION_PRIVATE,
        Value: isPrivate ? 'true' : 'false',
        Type: 'String',
        Overwrite: true,
      }))
    );

    // Start the instance
    console.log(`Starting EC2 instance: ${SERVER_INSTANCE_ID}`);
    await withRetry(() => ec2Client.send(new StartInstancesCommand({
      InstanceIds: [SERVER_INSTANCE_ID]
    })));
    console.log(`EC2 instance start command sent successfully`);

    const displayWorldName = selectedWorldConfig ? selectedWorldConfig.name : undefined;

    // Private start → quietly DM the owner(s) for cost/oversight awareness (the
    // session makes no public noise). Best-effort; skips the caller, who already
    // got the ephemeral reply. Normal public starts don't ping (the readiness
    // broadcast already tells the channel).
    if (isPrivate) {
      const starter = interaction?.member?.user ?? interaction?.user;
      const starterName = starter?.username ? `@${starter.username}` : "Someone";
      void dmOwners(ownerIds(), callerId(interaction), {
        embeds: [{
          title: "🔒 Private session starting",
          description:
            `${starterName} started a private **${ACTIVE_GAME.displayName}** session` +
            `${displayWorldName ? ` (world: **${displayWorldName}**)` : ""}.\n` +
            `No public announcement — it won't appear in the channel. ` +
            `Use \`${slash} join\` for the address once it's live.`,
          color: 0x39a0a0,
        }],
      });
    }

    // Private start: no public readiness ping, so tell the starter how friends
    // get in (each runs `/<cmd> join` for private details), and keep this very
    // reply ephemeral so the channel never sees the session spin up.
    const description = isPrivate
      ? `${persona.lines?.starting ?? 'The server is powering up.'} ` +
        'First boot can take several minutes while the server provisions.\n\n' +
        `🔒 **Private session.** The join address is never posted to the channel — run ` +
        `\`${slash} join\` when the bot's status shows it's playing the game. ` +
        `Make the game public with \`${slash} open\`.`
      : `${persona.lines?.starting ?? 'The server is powering up.'} ` +
        'First boot can take several minutes while the server provisions.\n\n' +
        'You\'ll get a notification with the join address when it\'s live.';

    return {
      statusCode: 200,
      body: JSON.stringify({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          embeds: [{
            title: isPrivate ? '🚀 Server Starting · 🔒 Private' : '🚀 Server Starting',
            description,
            color: 0x39a0a0,
            fields: displayWorldName ? [{
              name: '🌍 World',
              value: displayWorldName,
              inline: true,
            }] : [],
            footer: {
              text: persona.botName
            },
            timestamp: new Date().toISOString(),
          }],
          ...(isPrivate ? { flags: 64 } : {}), // ephemeral so the channel never sees a private session start
        }
      })
    };

  } catch (error) {
    console.error('Error in handleStartCommand:', error);
    return {
      statusCode: 200,
      body: JSON.stringify({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          embeds: [{
            title: '❌ Server Start Failed',
            description: 'Unable to start the server right now. Please try again in a moment.',
            color: 0xff0000,
            footer: { text: personaFooter('Contact admin if this persists') }
          }]
        }
      })
    };
  }
}
