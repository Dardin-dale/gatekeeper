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
  getServerLive,
  getSessionPrivate,
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
import { ACTIVE_GAME } from "../../games";
import { personaEmbed, slash } from "./util/persona";
import { buildJoinFields, joinHost } from "./util/join-info";
import { getScheduledOpening } from "./schedule";

export async function handleStatusCommand(): Promise<APIGatewayProxyResult> {
  try {
    console.log(`Getting server status details`);

    const { status, message: fastMessage, launchTime, publicIp } = await getFastServerStatus();
    console.log(`Server status retrieved: ${status}`);

    // Reply visibility auto-follows the session, so a private game's status —
    // including join details — stays off-channel.
    const sessionPrivate = await getSessionPrivate();
    const ephemeral = sessionPrivate;

    // Try to get the active world and player count from SSM. Abiotic Factor is
    // address-based (no join code); player count comes from the on-host A2S monitor.
    let activeWorld: string | undefined;
    let playerCount: number | undefined;
    // Instance running !== game joinable: the host monitor flips server-live on
    // its liveness transitions, so a booting game reads 'false' here.
    let gameLive = true;

    if (status === 'running') {
      gameLive = await getServerLive();
      try {
        const worldResult = await ssmClient.send(new GetParameterCommand({
          Name: SSM_PARAMS.ACTIVE_WORLD
        }));
        if (worldResult.Parameter?.Value) {
          const worldConfig = JSON.parse(worldResult.Parameter.Value);
          activeWorld = worldConfig.name || worldConfig.worldName;
        }
      } catch (err) {
        console.log('No active world found in SSM');
      }

      try {
        const playerCountResult = await ssmClient.send(new GetParameterCommand({
          Name: SSM_PARAMS.PLAYER_COUNT
        }));
        if (playerCountResult.Parameter?.Value) {
          playerCount = parseInt(playerCountResult.Parameter.Value, 10);
        }
      } catch (err) {
        console.log('No player count found in SSM');
      }
    }

    // Get auto-shutdown setting
    let autoShutdownMinutes: string | undefined;
    try {
      const shutdownResult = await ssmClient.send(new GetParameterCommand({
        Name: SSM_PARAMS.AUTO_SHUTDOWN_MINUTES
      }));
      autoShutdownMinutes = shutdownResult.Parameter?.Value;
    } catch (err) {
      console.log('Auto-shutdown parameter not found, using default');
      autoShutdownMinutes = '15';
    }

    // Determine server state
    let statusEmoji: string;
    let statusText: string;
    let description: string;
    let embedColor: number;

    if (status === 'stopped') {
      statusEmoji = '❌';
      statusText = 'Stopped';
      description = 'The server is currently offline.';
      embedColor = 0xff0000;
    } else if (status === 'stopping' || status === 'shutting-down') {
      statusEmoji = '🛑';
      statusText = 'Stopping';
      description = 'Server is shutting down...';
      embedColor = 0xff6600;
    } else if (status === 'running' && !gameLive) {
      statusEmoji = '⏳';
      statusText = 'Starting';
      description = `The instance is up, but the ${ACTIVE_GAME.displayName} server is still ` +
        `loading. The readiness ping posts here with the join details once it's joinable.`;
      embedColor = 0xffaa00;
    } else if (status === 'running') {
      statusEmoji = '✅';
      statusText = 'Online';
      description = `The ${ACTIVE_GAME.displayName} server is online.`;
      embedColor = 0x39a0a0;
    } else if (status === 'pending') {
      statusEmoji = '⏳';
      statusText = 'Starting';
      description = 'Server is starting up...';
      embedColor = 0xffaa00;
    } else {
      statusEmoji = '⚠️';
      statusText = 'Unknown';
      description = fastMessage;
      embedColor = 0xff6600;
    }

    let fields: Array<{name: string, value: string, inline: boolean}> = [
      {
        name: 'Status',
        value: `${statusEmoji} ${statusText}`,
        inline: true,
      }
    ];

    // Add world info if available
    if (activeWorld) {
      fields.push({
        name: 'World',
        value: `🌍 ${activeWorld}`,
        inline: true,
      });
    }

    // Add player count if available (written by the on-host A2S monitor)
    if (status === 'running' && gameLive && playerCount !== undefined) {
      fields.push({
        name: 'Players',
        value: `👥 ${playerCount}`,
        inline: true,
      });
    }

    // Add uptime if running
    if (status === 'running' && launchTime) {
      const uptimeMs = Date.now() - launchTime.getTime();
      const uptimeMinutes = Math.floor(uptimeMs / (1000 * 60));
      const uptimeHours = Math.floor(uptimeMinutes / 60);
      const remainingMinutes = uptimeMinutes % 60;

      fields.push({
        name: 'Uptime',
        value: uptimeHours > 0 ? `${uptimeHours}h ${remainingMinutes}m` : `${uptimeMinutes}m`,
        inline: true,
      });
    }

    // Next scheduled opening, if one is set (best-effort — never block status)
    try {
      const opening = await getScheduledOpening();
      if (opening && opening.opensAtEpoch > Date.now()) {
        const t = Math.floor(opening.opensAtEpoch / 1000);
        fields.push({
          name: 'Next Opening',
          value: `📅 <t:${t}:R>${opening.worldName ? ` (${opening.worldName})` : ''}`,
          inline: true,
        });
      }
    } catch (err) {
      console.log('Could not read scheduled opening');
    }

    // Add auto-shutdown info
    if (autoShutdownMinutes) {
      const shutdownText = autoShutdownMinutes === 'off' || autoShutdownMinutes === 'disabled'
        ? '⏸️ Disabled'
        : `⏱️ ${autoShutdownMinutes}m idle`;
      fields.push({
        name: 'Auto-Shutdown',
        value: shutdownText,
        inline: true,
      });
    }

    // Mark a private (quiet) session so it's clear there's no public announcement.
    if (status === 'running' && sessionPrivate) {
      fields.push({ name: 'Visibility', value: '🔒 Private session', inline: true });
    }

    // Join info once the game is actually joinable — same per-game format as
    // /gate join (address/port/password/lobby code via the shared util/join-info).
    if (status === 'running' && gameLive && ACTIVE_GAME.join.type === 'address') {
      const host = joinHost(publicIp);
      if (host) {
        fields.push(...await buildJoinFields(host));
      }
    }

    const footerSuffix = status === 'running'
      ? `Use ${slash} stop when done playing`
      : `Use ${slash} start to launch the server`;

    return {
      statusCode: 200,
      body: JSON.stringify({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          embeds: [personaEmbed({
            title: `${ACTIVE_GAME.displayName} Server Status`,
            description,
            color: embedColor,
            footerSuffix,
            extra: { fields, timestamp: new Date().toISOString() },
          })],
          ...(ephemeral ? { flags: 64 } : {}),
        },
      }),
    };
  } catch (error) {
    console.error('Error in handleStatusCommand:', error);
    return {
      statusCode: 200,
      body: JSON.stringify({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: '❌ Failed to get server status. Please try again.',
        },
      }),
    };
  }
}
