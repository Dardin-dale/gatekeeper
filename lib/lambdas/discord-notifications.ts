import { EventBridgeEvent, Context } from 'aws-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { persona, personaEmbed } from './commands/util/persona';
import { ACTIVE_GAME } from '../games';

// Create AWS clients
const ssmClient = new SSMClient();

// SSM Parameter names (scoped to the active game's subtree)
const ACTIVE_WORLD_PARAM = `/gatekeeper/${ACTIVE_GAME.id}/active-world`;
const DISCORD_WEBHOOK_BASE = `/gatekeeper/${ACTIVE_GAME.id}/discord-webhook`;

/**
 * Discord notifications driven by EventBridge.
 *
 * The on-host monitor (scripts/game/monitor.sh) posts the readiness ping and the
 * idle "backing up + shutting down" message directly to the webhook, so this
 * Lambda is left with the one notification the host can't send: the *final*
 * "server stopped" confirmation, which fires from AWS's own EC2 state-change
 * event after the instance is gone.
 */
async function getWebhookUrl(): Promise<string> {
  // Resolve the webhook for the active world's guild.
  let guildId: string | undefined;
  try {
    const activeWorldResult = await ssmClient.send(new GetParameterCommand({
      Name: ACTIVE_WORLD_PARAM,
    }));
    if (activeWorldResult.Parameter?.Value) {
      guildId = JSON.parse(activeWorldResult.Parameter.Value).discordServerId;
    }
  } catch (err) {
    console.log('No active world found; cannot resolve a webhook');
  }

  if (guildId) {
    try {
      const webhookResult = await ssmClient.send(new GetParameterCommand({
        Name: `${DISCORD_WEBHOOK_BASE}/${guildId}`,
      }));
      if (webhookResult.Parameter?.Value) {
        return webhookResult.Parameter.Value;
      }
    } catch (err) {
      console.log(`No webhook found for guild ${guildId}`);
    }
  }

  throw new Error('No Discord webhook configured - use /gate setup in Discord');
}

export async function handler(
  event: EventBridgeEvent<string, any>,
  _context: Context
): Promise<void> {
  console.log('Event received:', JSON.stringify(event, null, 2));

  try {
    const eventType = event['detail-type'];
    console.log(`Processing event type: ${eventType}`);

    let message: any;
    switch (eventType) {
      case 'EC2 Instance State-change Notification':
        if (event.detail.state === 'stopped') {
          message = handleEC2StoppedEvent(event.detail);
        }
        break;
      default:
        console.log(`Unknown event type: ${eventType}`);
        return;
    }

    if (!message) {
      console.log('No message to send');
      return;
    }

    try {
      const webhookUrl = await getWebhookUrl();
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
      });
      if (!response.ok) {
        throw new Error(`Discord webhook returned ${response.status}`);
      }
      console.log(`Discord notification sent successfully for ${eventType}`);
    } catch (error) {
      // Don't fail the Lambda just because the Discord post failed.
      console.error('Failed to send Discord notification:', error);
    }
  } catch (error) {
    console.error('Error in notification handler:', error);
  }
}

/** Final confirmation once the instance actually reaches the stopped state. */
function handleEC2StoppedEvent(detail: any): any {
  const time = detail.time ? new Date(detail.time) : new Date();
  return {
    // Post as the persona in full (e.g. Dr. Derek Manse) with his hologram avatar.
    username: persona.characterName,
    ...(persona.thumbnailUrl ? { avatar_url: persona.thumbnailUrl } : {}),
    embeds: [
      personaEmbed({
        title: '🛑 Server Offline',
        description: 'The facility has powered down completely. Use `/gate start` when you want to play again.',
        color: 0x95a5a6, // gray
        extra: { timestamp: time.toISOString() },
      }),
    ],
  };
}
