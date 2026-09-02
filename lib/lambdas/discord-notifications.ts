import { EventBridgeEvent, Context } from 'aws-lambda';
import { SchedulerClient, CreateScheduleCommand } from '@aws-sdk/client-scheduler';
import { persona, personaAvatarUrl, slash } from './commands/util/persona';
import { ACTIVE_GAME } from '../games';
import {
  getActiveGuildId,
  getActiveWorldName,
  getMessageTtlHours,
  getPinnedStatusParam,
  getRawParam,
  getSessionPrivate,
  getStatusMessageId,
  getWebhookForGuild,
  invalidateSessionParams,
} from './utils/params';

const schedulerClient = new SchedulerClient({});

// EventBridge Scheduler wiring (shared with the openings feature): a one-off
// schedule in the per-game group fires the scheduler Lambda to delete a message.
const SCHEDULER_GROUP = process.env.SCHEDULER_GROUP || '';
const SCHEDULER_TARGET_ARN = process.env.SCHEDULER_TARGET_ARN || '';
const SCHEDULER_ROLE_ARN = process.env.SCHEDULER_ROLE_ARN || '';

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
  // A durable PINNED status message is edited across sessions, so the per-session
  // TTL must never delete it — that would silently unpin the channel's one
  // permanent status post and strand the SSM pointer at a dead message id.
  const pinned = await getRawParam(getPinnedStatusParam(guildId));
  if (pinned && pinned !== 'none') {
    try {
      if (JSON.parse(pinned)?.messageId === messageId) {
        console.log(`Message ${messageId} is the pinned status message; not scheduling deletion`);
        return;
      }
    } catch { /* unparseable pin record: fall through and treat as not pinned */ }
  }
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
 * Discord notifications driven by EventBridge.
 *
 * The on-host monitor (scripts/game/monitor.sh) posts the readiness ping and the
 * idle "backing up + shutting down" message directly to the webhook, so this
 * Lambda is left with the one notification the host can't send: the *final*
 * "server stopped" confirmation, which fires from AWS's own EC2 state-change
 * event after the instance is gone.
 *
 * Resolve the webhook for the active world's guild; throws (caught by the
 * handler) when none is configured so we never post to a dead URL.
 */
async function getWebhookUrl(): Promise<string> {
  const guildId = await getActiveGuildId();
  const url = guildId ? await getWebhookForGuild(guildId) : undefined;
  if (!url) {
    throw new Error(`No Discord webhook configured - use ${slash} setup in Discord`);
  }
  return url;
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
    // DESIGN FORK — "update-in-place" vs "message-per-status".
    //
    // Current (update-in-place): a session is ONE Discord message that the host
    // and this Lambda PATCH through its lifecycle (Online → Winding Down →
    // Offline). statusMessageId is that message's id, captured when it was first
    // posted; we edit it here instead of posting a second message. Keeps the
    // channel tidy — one row per session — but couples the components: the host
    // must hand off the id (SSM status-message-id) and a deleted/expired message
    // forces the 404/400 fallback below.
    //
    // Alternative (message-per-status): each transition posts its own fresh
    // message. Simpler and fully decoupled (no id handoff, no PATCH edge cases),
    // at the cost of N messages per session cluttering the channel.
    //
    // The fork is gated entirely on statusMessageId being present: it is read
    // from SSM and PATCHed when set, else we POST fresh. To revert to
    // message-per-status, stop capturing the id (host + `getStatusMessageId`)
    // and this path falls back to plain POSTs automatically.
    let statusMessageId: string | undefined;
    switch (eventType) {
      case 'EC2 Instance State-change Notification':
        if (event.detail.state === 'stopped') {
          // Read privacy + the status message id + world name BEFORE invalidating.
          const privateSession = await getSessionPrivate();
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
    // Explicit empty content: a webhook edit leaves omitted fields alone, and the
    // pinned status is edited across sessions — this scrubs any stale text (an
    // old @starter mention) so the next session doesn't inherit it.
    content: '',
    allowed_mentions: { parse: [] },
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
