import { EventBridgeEvent, Context } from 'aws-lambda';
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { persona, personaEmbed, personaAvatarUrl, slash } from './commands/util/persona';
import { ACTIVE_GAME } from '../games';

// Create AWS clients
const ssmClient = new SSMClient();

// SSM Parameter names (scoped to the active game's subtree)
const ACTIVE_WORLD_PARAM = `/gatekeeper/${ACTIVE_GAME.id}/active-world`;
const DISCORD_WEBHOOK_BASE = `/gatekeeper/${ACTIVE_GAME.id}/discord-webhook`;
const JOIN_CODE_PARAM = `/gatekeeper/${ACTIVE_GAME.id}/join-code`;
const SERVER_LIVE_PARAM = `/gatekeeper/${ACTIVE_GAME.id}/server-live`;
const SESSION_PRIVATE_PARAM = `/gatekeeper/${ACTIVE_GAME.id}/session-private`;
const STATUS_MESSAGE_ID_PARAM = `/gatekeeper/${ACTIVE_GAME.id}/status-message-id`;

/** Was the just-ended session private? Then suppress the public "offline" post. */
async function wasSessionPrivate(): Promise<boolean> {
  try {
    const r = await ssmClient.send(new GetParameterCommand({ Name: SESSION_PRIVATE_PARAM }));
    return r.Parameter?.Value === 'true';
  } catch {
    return false;
  }
}

/**
 * The id of this session's readiness ("Server Online") message, captured by the
 * host (or /<cmd> open) when it posted. We EDIT that message into the offline
 * state instead of posting a second one — so a session shows as one message that
 * flips Online→Offline. 'none'/absent means nothing was posted (private or the
 * online notice was off), so we fall back to posting fresh.
 */
async function getStatusMessageId(): Promise<string | undefined> {
  try {
    const r = await ssmClient.send(new GetParameterCommand({ Name: STATUS_MESSAGE_ID_PARAM }));
    const v = r.Parameter?.Value;
    return v && v !== 'none' ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The join code is per-session: once the instance is stopped it's dead, and
 * /gate join|status must not show it next boot. The host scripts clear these on
 * their own stop paths, but this Lambda fires on EVERY stop — idle, /gate stop,
 * crash, console — so it's the invalidation catch-all.
 */
async function invalidateSessionParams(): Promise<void> {
  // Also reset session-private to public: it's per-start, so clearing it on stop
  // keeps the default public — a later scheduled/normal start is never mistaken
  // for the previous private session.
  for (const [name, value] of [[JOIN_CODE_PARAM, 'none'], [SERVER_LIVE_PARAM, 'false'], [SESSION_PRIVATE_PARAM, 'false'], [STATUS_MESSAGE_ID_PARAM, 'none']]) {
    try {
      await ssmClient.send(new PutParameterCommand({
        Name: name, Value: value, Type: 'String', Overwrite: true,
      }));
    } catch (err) {
      console.error(`Failed to invalidate ${name}:`, err);
    }
  }
}

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

  throw new Error(`No Discord webhook configured - use ${slash} setup in Discord`);
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
    let statusMessageId: string | undefined; // edit this readiness message in place, if present
    switch (eventType) {
      case 'EC2 Instance State-change Notification':
        if (event.detail.state === 'stopped') {
          // Read privacy + the status message id BEFORE invalidating (which resets both).
          const privateSession = await wasSessionPrivate();
          statusMessageId = await getStatusMessageId();
          await invalidateSessionParams();
          if (privateSession) {
            console.log('Private session ended — suppressing public offline notification');
          } else {
            message = handleEC2StoppedEvent(event.detail);
          }
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
      // Edit the session's readiness message into the offline state when we have
      // it (one message flips Online→Offline); otherwise post a fresh offline.
      const url = statusMessageId ? `${webhookUrl}/messages/${statusMessageId}` : webhookUrl;
      const response = await fetch(url, {
        method: statusMessageId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
      });
      if (!response.ok) {
        // A deleted/expired message can't be edited — fall back to a fresh post.
        if (statusMessageId && (response.status === 404 || response.status === 400)) {
          console.log('Status message gone; posting a fresh offline notice');
          const fresh = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(message),
          });
          if (!fresh.ok) throw new Error(`Discord webhook returned ${fresh.status}`);
          console.log(`Discord notification sent successfully for ${eventType}`);
          return;
        }
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
    // Post as the persona: the bot's app icon is the avatar, the character art
    // rides inside the embed as its thumbnail (matches the host webhook posts).
    username: persona.characterName,
    ...(personaAvatarUrl ? { avatar_url: personaAvatarUrl } : {}),
    embeds: [
      personaEmbed({
        // Webhook identity above already names the character; no byline repeat.
        byline: false,
        withThumbnail: true,
        title: '🛑 Server Offline',
        description: `${persona.lines?.offline ?? 'The server has shut down completely.'}\n` +
          `Use \`${slash} start\` when you want to play again.`,
        color: 0x95a5a6, // gray
        extra: { timestamp: time.toISOString() },
      }),
    ],
  };
}
