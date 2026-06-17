import { EventBridgeEvent, Context } from 'aws-lambda';
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { SchedulerClient, CreateScheduleCommand } from '@aws-sdk/client-scheduler';
import { persona, personaAvatarUrl, slash } from './commands/util/persona';
import { ACTIVE_GAME } from '../games';

// Create AWS clients
const ssmClient = new SSMClient();
const schedulerClient = new SchedulerClient({});

// EventBridge Scheduler wiring (shared with the openings feature): a one-off
// schedule in the per-game group fires the scheduler Lambda to delete a message.
const SCHEDULER_GROUP = process.env.SCHEDULER_GROUP || '';
const SCHEDULER_TARGET_ARN = process.env.SCHEDULER_TARGET_ARN || '';
const SCHEDULER_ROLE_ARN = process.env.SCHEDULER_ROLE_ARN || '';
const MESSAGE_TTL_HOURS_PARAM = `/gatekeeper/${ACTIVE_GAME.id}/message-ttl-hours`;

// SSM Parameter names (scoped to the active game's subtree)
const ACTIVE_WORLD_PARAM = `/gatekeeper/${ACTIVE_GAME.id}/active-world`;
const DISCORD_WEBHOOK_BASE = `/gatekeeper/${ACTIVE_GAME.id}/discord-webhook`;
const JOIN_CODE_PARAM = `/gatekeeper/${ACTIVE_GAME.id}/join-code`;
const SERVER_LIVE_PARAM = `/gatekeeper/${ACTIVE_GAME.id}/server-live`;
const SESSION_PRIVATE_PARAM = `/gatekeeper/${ACTIVE_GAME.id}/session-private`;
const STATUS_MESSAGE_ID_PARAM = `/gatekeeper/${ACTIVE_GAME.id}/status-message-id`;
const EXTEND_UNTIL_PARAM = `/gatekeeper/${ACTIVE_GAME.id}/extend-until`;

/** The active world's display name — the constant status-message title (matches the
 *  host's world_title), so the offline edit keeps the same headline as Online. */
async function getActiveWorldName(): Promise<string | undefined> {
  try {
    const r = await ssmClient.send(new GetParameterCommand({ Name: ACTIVE_WORLD_PARAM }));
    if (!r.Parameter?.Value) return undefined;
    const w = JSON.parse(r.Parameter.Value);
    return w.name || w.worldName || undefined;
  } catch {
    return undefined;
  }
}

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

/** Auto-delete TTL in hours (0 = off/unset/invalid → keep the message forever). */
async function getMessageTtlHours(): Promise<number> {
  try {
    const r = await ssmClient.send(new GetParameterCommand({ Name: MESSAGE_TTL_HOURS_PARAM }));
    const v = r.Parameter?.Value;
    if (!v || v === 'off' || v === 'disabled') return 0;
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** The active world's guild id — passed into the delete schedule so it resolves
 *  the right webhook when it fires (active-world could change before then). */
async function getActiveGuildId(): Promise<string | undefined> {
  try {
    const r = await ssmClient.send(new GetParameterCommand({ Name: ACTIVE_WORLD_PARAM }));
    return r.Parameter?.Value ? JSON.parse(r.Parameter.Value).discordServerId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Schedule this session's status message to auto-delete `message-ttl-hours` after
 * it goes offline — a one-off EventBridge schedule firing the scheduler Lambda's
 * delete-message action (self-cleaning). Best-effort; never blocks the offline post.
 */
async function scheduleStatusMessageDeletion(messageId: string): Promise<void> {
  const ttlHours = await getMessageTtlHours();
  if (ttlHours <= 0) { console.log('Message TTL off; not scheduling deletion'); return; }
  if (!SCHEDULER_GROUP || !SCHEDULER_TARGET_ARN || !SCHEDULER_ROLE_ARN) {
    console.log('Scheduler not configured; skipping TTL deletion'); return;
  }
  const guildId = await getActiveGuildId();
  if (!guildId) { console.log('No guild resolved; skipping TTL deletion'); return; }
  const fireAt = new Date(Date.now() + ttlHours * 3_600_000).toISOString().slice(0, 19);
  try {
    await schedulerClient.send(new CreateScheduleCommand({
      Name: `delete-msg-${messageId}`,
      GroupName: SCHEDULER_GROUP,
      ScheduleExpression: `at(${fireAt})`,
      ScheduleExpressionTimezone: 'UTC',
      FlexibleTimeWindow: { Mode: 'OFF' },
      ActionAfterCompletion: 'DELETE',
      Target: {
        Arn: SCHEDULER_TARGET_ARN,
        RoleArn: SCHEDULER_ROLE_ARN,
        Input: JSON.stringify({ action: 'delete-message', messageId, guildId }),
        RetryPolicy: { MaximumRetryAttempts: 3, MaximumEventAgeInSeconds: 300 },
      },
    }));
    console.log(`Scheduled status message ${messageId} to auto-delete in ${ttlHours}h`);
  } catch (err) {
    console.error('Failed to schedule message deletion:', err);
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
  for (const [name, value] of [[JOIN_CODE_PARAM, 'none'], [SERVER_LIVE_PARAM, 'false'], [SESSION_PRIVATE_PARAM, 'false'], [STATUS_MESSAGE_ID_PARAM, 'none'], [EXTEND_UNTIL_PARAM, '0']]) {
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
          // Read privacy + the status message id + world name BEFORE invalidating.
          const privateSession = await wasSessionPrivate();
          statusMessageId = await getStatusMessageId();
          const worldName = await getActiveWorldName();
          await invalidateSessionParams();
          // Edit the session's status message (the online ping OR the private cue)
          // into the offline state — editing is silent, so it's correct for a
          // private session too. Only fully suppress when private AND nothing was
          // posted (no message to edit), so we never create a fresh public post.
          if (privateSession && !statusMessageId) {
            console.log('Private session with no status message — nothing to post');
          } else {
            message = handleEC2StoppedEvent(event.detail, worldName);
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
      // The offline message IS this session's status message — schedule it to
      // auto-delete after the TTL so the channel doesn't accrete old sessions.
      if (statusMessageId) await scheduleStatusMessageDeletion(statusMessageId);
    } catch (error) {
      // Don't fail the Lambda just because the Discord post failed.
      console.error('Failed to send Discord notification:', error);
    }
  } catch (error) {
    console.error('Error in notification handler:', error);
  }
}

/**
 * Final state of the session's status message once the instance reaches 'stopped'.
 * Built to MATCH the host's build_payload shape exactly (constant world-name title,
 * a 🛑 status line leading the description, persona footer/thumbnail, no byline or
 * timestamp), so the edit reads as the same message updating — not a foreign post.
 * `components: []` clears the Stop/Extend buttons.
 */
function handleEC2StoppedEvent(_detail: any, worldName?: string): any {
  return {
    username: persona.characterName,
    ...(personaAvatarUrl ? { avatar_url: personaAvatarUrl } : {}),
    components: [], // drop the live-control buttons now that the session is over
    embeds: [{
      title: worldName ?? ACTIVE_GAME.displayName,
      description: `🛑 **Offline** · ${persona.lines?.offline ?? 'The server has shut down completely.'}\n` +
        `Use \`${slash} start\` to play again.`,
      color: 0x95a5a6, // gray
      footer: { text: persona.footer },
      ...(persona.thumbnailUrl ? { thumbnail: { url: persona.thumbnailUrl } } : {}),
    }],
  };
}
