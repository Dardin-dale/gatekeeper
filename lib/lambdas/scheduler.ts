import { EC2Client, StartInstancesCommand } from '@aws-sdk/client-ec2';
import { GetParameterCommand, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { ACTIVE_GAME } from '../games';
import { WorldConfig } from './utils/world-config';
import { persona, personaAvatarUrl, pickLine } from './commands/util/persona';

/**
 * Scheduled-openings Lambda (Phase 11) — the EventBridge Scheduler target.
 *
 * /gate schedule set creates one-time schedules in the per-game group that
 * invoke this function:
 *   - action "start" at the pre-warm instant (announced time minus
 *     prewarm-minutes): write the world resolved AT SCHEDULING TIME to the
 *     active-world param, then start the instance — the same effect as
 *     /gate start, minus Discord plumbing. The readiness ping announces the
 *     actual "doors open".
 *   - action "countdown" at T-60/T-10: post a persona webhook message with a
 *     native Discord timestamp (renders in each viewer's local timezone).
 *
 * Schedules are created with ActionAfterCompletion=DELETE, so a fired schedule
 * cleans itself up — "no scheduled opening" is the natural state afterwards.
 */

const ec2Client = new EC2Client();
const ssmClient = new SSMClient();

const SERVER_INSTANCE_ID = process.env.SERVER_INSTANCE_ID || '';
const SSM_PREFIX = `/gatekeeper/${ACTIVE_GAME.id}`;

export interface ScheduleFireEvent {
  action: 'start' | 'countdown' | 'delete-message';
  opensAtEpoch?: number;      // the ANNOUNCED opening (not the pre-warm instant); unused by delete-message
  guildId?: string;           // for webhook resolution (countdown posts, message delete)
  world?: WorldConfig | null; // resolved when the schedule was created
  minutesBefore?: number;     // countdown label (60, 10)
  messageId?: string;         // delete-message: the webhook message to remove
}

export async function handler(event: ScheduleFireEvent): Promise<void> {
  console.log('Schedule fired:', JSON.stringify({ ...event, world: event.world?.name }));

  // TTL cleanup: delete a session's lifecycle status message N hours after it
  // went offline (scheduled by the offline-notification Lambda). Self-cleaning
  // schedule (ActionAfterCompletion=DELETE). 404 = already gone, fine.
  if (event.action === 'delete-message') {
    if (!event.messageId) return;
    const url = await getWebhookUrl(event.guildId);
    if (!url) { console.log('No webhook; cannot delete message'); return; }
    const res = await fetch(`${url}/messages/${event.messageId}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) console.error(`Message delete failed: ${res.status}`);
    else console.log(`Deleted status message ${event.messageId} (TTL)`);
    return;
  }

  if (event.action === 'start') {
    if (event.world) {
      await ssmClient.send(new PutParameterCommand({
        Name: `${SSM_PREFIX}/active-world`,
        Value: JSON.stringify(event.world),
        Type: 'String',
        Overwrite: true,
      }));
      console.log(`Active world set to ${event.world.name}`);
    }
    if (!SERVER_INSTANCE_ID) throw new Error('SERVER_INSTANCE_ID not set');
    // No-op if already running — someone starting early never breaks the schedule.
    await ec2Client.send(new StartInstancesCommand({ InstanceIds: [SERVER_INSTANCE_ID] }));
    console.log(`Instance ${SERVER_INSTANCE_ID} start requested (scheduled opening ` +
      `at ${new Date(event.opensAtEpoch!).toISOString()})`);
    return;
  }

  if (event.action === 'countdown') {
    const url = await getWebhookUrl(event.guildId);
    if (!url) {
      console.log('No webhook configured; skipping countdown post');
      return;
    }
    const t = Math.floor(event.opensAtEpoch! / 1000);
    // Persona flavor leads; the operational line below it carries the facts.
    const flavor = pickLine(
      persona.lines?.countdown,
      `The ${ACTIVE_GAME.displayName} server opens soon.`,
    );
    const payload = {
      username: persona.characterName,
      ...(personaAvatarUrl ? { avatar_url: personaAvatarUrl } : {}),
      embeds: [{
        title: '📅 Scheduled Opening',
        description:
          `${flavor}\n\n` +
          `Doors open <t:${t}:R> — <t:${t}:t>.` +
          `${event.world?.name ? `\nWorld: **${event.world.name}**.` : ''}` +
          `\nThe join details are posted here the moment it's ready.`,
        color: 0xffaa00,
        ...(persona.footer ? { footer: { text: persona.footer } } : {}),
      }],
    };
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      console.error(`Countdown webhook post failed: ${response.status}`);
    }
  }
}

/** The guild webhook (SecureString) — same per-guild param the host scripts use. */
async function getWebhookUrl(guildId?: string): Promise<string | undefined> {
  if (!guildId) return undefined;
  try {
    const result = await ssmClient.send(new GetParameterCommand({
      Name: `${SSM_PREFIX}/discord-webhook/${guildId}`,
      WithDecryption: true,
    }));
    return result.Parameter?.Value || undefined;
  } catch (err) {
    console.log(`No webhook for guild ${guildId}`);
    return undefined;
  }
}
