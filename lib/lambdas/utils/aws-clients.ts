import { 
  EC2Client, 
  DescribeInstancesCommand 
} from "@aws-sdk/client-ec2";
import {
  SSMClient,
  GetParameterCommand,
} from "@aws-sdk/client-ssm";
import {
  S3Client
} from "@aws-sdk/client-s3";
import { ACTIVE_GAME } from "../../games";

// AWS client configuration optimized for Discord interactions
// Balanced timeout and retry configuration for reliable responses
const awsClientConfig = {
  requestTimeout: 15000, // 15 second timeout for individual requests
  region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-west-2',
  maxAttempts: 2, // Two attempts to handle transient failures
};

// Create and export AWS clients with timeout configuration
export const ec2Client = new EC2Client(awsClientConfig);
export const ssmClient = new SSMClient(awsClientConfig);
export const s3Client = new S3Client(awsClientConfig);

/**
 * Robust retry wrapper for AWS API calls with exponential backoff
 * @param operation Function to retry
 * @param maxRetries Maximum number of retry attempts (default: 2 for reliability)
 * @param baseDelay Base delay in ms (default: 1000ms)
 * @returns Result of the operation
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  maxRetries: number = 2,
  baseDelay: number = 1000
): Promise<T> {
  let retryCount = 0;

  while (true) {
    try {
      return await operation();
    } catch (error) {
      retryCount++;

      if (retryCount >= maxRetries) {
        console.error(`Failed after ${maxRetries} attempts:`, error);
        throw error;
      }

      // Exponential backoff: 1s, 2s, 4s...
      const delay = baseDelay * Math.pow(2, retryCount - 1);
      console.log(`Retry attempt ${retryCount}/${maxRetries} after ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// Common environment variables
export const SERVER_INSTANCE_ID = process.env.SERVER_INSTANCE_ID || '';
export const BACKUP_BUCKET_NAME = process.env.BACKUP_BUCKET_NAME || '';

// SSM Parameter paths
// All SSM paths live under the active game's subtree so each game's stack is
// self-contained: /gatekeeper/<game-id>/... (matches the host scripts + the stack).
const SSM_PREFIX = `/gatekeeper/${ACTIVE_GAME.id}`;
export const SSM_PARAMS = {
  ACTIVE_WORLD: `${SSM_PREFIX}/active-world`,
  DISCORD_WEBHOOK: `${SSM_PREFIX}/discord-webhook`, // base path; per-guild webhook is appended
  AUTO_SHUTDOWN_MINUTES: `${SSM_PREFIX}/auto-shutdown-minutes`,
  BOOT_TIMEOUT_MINUTES: `${SSM_PREFIX}/boot-timeout-minutes`,
  PLAYER_COUNT: `${SSM_PREFIX}/player-count`,
  JOIN_CODE: `${SSM_PREFIX}/join-code`, // per-session lobby code scraped by the host monitor ('none' = absent)
  SERVER_LIVE: `${SSM_PREFIX}/server-live`, // 'true' while the game answers the host monitor's liveness checks
  SESSION_PRIVATE: `${SSM_PREFIX}/session-private`, // 'true' for a quiet session: host skips the public online ping, join/status reply privately. Set per-start, flipped off by /<cmd> open.
  STATUS_MESSAGE_ID: `${SSM_PREFIX}/status-message-id`, // id of this session's readiness message; the offline notification edits it in place ('none' = post fresh)
  MESSAGE_TTL_HOURS: `${SSM_PREFIX}/message-ttl-hours`, // hours after offline before the status message auto-deletes ('off' = keep)
  PREWARM_MINUTES: `${SSM_PREFIX}/prewarm-minutes`, // scheduled openings: start this many minutes before the announced time
  // Per-category notification toggles: /gatekeeper/<game-id>/notify/<category> = on|off
  // (read by the host post_discord; absent = on). See lib/lambdas/commands/notify.ts.
  NOTIFY_PREFIX: `${SSM_PREFIX}/notify`,
  // Per-Discord-server default world: /gatekeeper/<game-id>/discord/<guild-id>/default-world
  GUILD_DEFAULT_WORLD_PREFIX: `${SSM_PREFIX}/discord`,
};

/** Fixed lifecycle notification categories every game has. */
export const SYSTEM_NOTIFY_CATEGORIES = [
  { key: "online", label: "🟢 Server online / ready" },
  { key: "idle", label: "💤 Idle-shutdown notice" },
  { key: "backup", label: "💾 Backup complete" },
  { key: "failed", label: "⚠️ Failed to start" },
] as const;

/**
 * Every notification category for the active game: the system ones plus one per
 * distinct event category the profile defines (e.g. deaths, raids, joins). This
 * is the source of truth for both `/<cmd> notify` validation/listing and the
 * registered command's choices.
 */
export function notifyCategories(): { key: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const { key, label } of SYSTEM_NOTIFY_CATEGORIES) seen.set(key, label);
  for (const e of ACTIVE_GAME.events ?? []) {
    const cat = e.category ?? e.id;
    if (!seen.has(cat)) seen.set(cat, e.label ?? cat);
  }
  return [...seen].map(([key, label]) => ({ key, label }));
}

/** SSM path for a notification category's on/off toggle. */
export function getNotifyParam(category: string): string {
  return `${SSM_PARAMS.NOTIFY_PREFIX}/${category}`;
}

/**
 * Get the SSM parameter path for a guild's default world
 */
export function getGuildDefaultWorldParam(guildId: string): string {
  return `${SSM_PARAMS.GUILD_DEFAULT_WORLD_PREFIX}/${guildId}/default-world`;
}

/**
 * Whether the game itself is up, as opposed to just the EC2 instance: the host
 * monitor writes 'true'/'false' on liveness transitions and 'false' at session
 * start/stop. A missing parameter counts as live so sessions predating the flag
 * (or a wiped param) never suppress join info.
 */
export async function getServerLive(): Promise<boolean> {
  try {
    const result = await ssmClient.send(new GetParameterCommand({
      Name: SSM_PARAMS.SERVER_LIVE,
    }));
    return result.Parameter?.Value !== 'false';
  } catch (err) {
    return true;
  }
}

/**
 * Whether the current session is private (quiet): started with `/<cmd> start
 * private`. The host then skips the public "Server Online" broadcast, and
 * /<cmd> join|status reply ephemerally. Set per-start (so a normal start resets
 * it to public) and flipped off by `/<cmd> open`. Absent/anything-but-'true'
 * counts as public — the safe default (never accidentally hides a public game).
 */
export async function getSessionPrivate(): Promise<boolean> {
  try {
    const result = await ssmClient.send(new GetParameterCommand({
      Name: SSM_PARAMS.SESSION_PRIVATE,
    }));
    return result.Parameter?.Value === 'true';
  } catch (err) {
    return false;
  }
}

/**
 * Get the current status of the game server EC2 instance
 * @returns EC2 instance status (running, stopped, pending, stopping, etc.)
 */
export async function getInstanceStatus(): Promise<string> {
  if (!SERVER_INSTANCE_ID) {
    throw new Error("Missing SERVER_INSTANCE_ID environment variable");
  }
  
  return withRetry(async () => {
    const command = new DescribeInstancesCommand({
      InstanceIds: [SERVER_INSTANCE_ID]
    });
    
    const response = await ec2Client.send(command);
    
    if (!response.Reservations || response.Reservations.length === 0 || 
        !response.Reservations[0].Instances || response.Reservations[0].Instances.length === 0) {
      throw new Error("Instance not found");
    }
    
    return response.Reservations[0].Instances[0].State?.Name || 'unknown';
  });
}

/**
 * Get fast basic server status - just EC2 instance state
 * Optimized for Discord responsiveness with timeout protection
 * @returns Object with basic status info
 */
export async function getFastServerStatus(): Promise<{
  status: string;
  message: string;
  launchTime?: Date;
  publicIp?: string;
}> {
  try {
    // Use withRetry which already has proper timeout handling via AWS client config
    const details = await withRetry(() => getInstanceDetails(), 1, 500);
    return {
      status: details.status,
      message: getStatusMessage(details.status),
      launchTime: details.launchTime,
      publicIp: details.publicIp
    };
  } catch (error) {
    console.error('Fast server status check failed:', error);
    // Return a reasonable default instead of failing completely
    return {
      status: 'unknown',
      message: 'Server status temporarily unavailable',
    };
  }
}

/**
 * Get a human-readable message for a server status
 */
export function getStatusMessage(status: string): string {
  switch (status) {
    case 'running':
      return "Server is online and ready to play!";
    case 'pending':
      return "Server is starting up. Please wait a few minutes.";
    case 'stopping':
      return "Server is shutting down.";
    case 'stopped':
      return "Server is offline. Use the start command to launch it.";
    default:
      return `Server status: ${status}`;
  }
}

/**
 * Get instance details including public IP
 */
export async function getInstanceDetails() {
  if (!SERVER_INSTANCE_ID) {
    throw new Error("Missing SERVER_INSTANCE_ID environment variable");
  }
  
  return withRetry(async () => {
    const command = new DescribeInstancesCommand({
      InstanceIds: [SERVER_INSTANCE_ID]
    });
    
    const response = await ec2Client.send(command);
    
    if (!response.Reservations || response.Reservations.length === 0 || 
        !response.Reservations[0].Instances || response.Reservations[0].Instances.length === 0) {
      throw new Error("Instance not found");
    }
    
    const instance = response.Reservations[0].Instances[0];
    return {
      status: instance.State?.Name || 'unknown',
      publicIp: instance.PublicIpAddress,
      instanceId: instance.InstanceId,
      launchTime: instance.LaunchTime
    };
  });
}