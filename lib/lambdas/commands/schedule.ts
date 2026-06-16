import { APIGatewayProxyResult } from "aws-lambda";
import {
  CreateScheduleCommand,
  DeleteScheduleCommand,
  GetScheduleCommand,
  ListSchedulesCommand,
  SchedulerClient,
} from "@aws-sdk/client-scheduler";
import { GetParameterCommand } from "@aws-sdk/client-ssm";
import { ssmClient, SSM_PARAMS, getGuildDefaultWorldParam } from "../utils/aws-clients";
import { WORLD_CONFIGS, WorldConfig, getDefaultWorldConfig } from "../utils/world-config";
import { parseWhen, WhenParseError } from "../utils/schedule-time";
import { InteractionResponseType } from "./types";
import { persona, personaEmbed, pickLine, slash } from "./util/persona";
import type { ScheduleFireEvent } from "../scheduler";

/**
 * /gate schedule set|clear|list — scheduled openings (Phase 11 v1).
 *
 * One upcoming opening at a time: `set` replaces whatever is scheduled. Three
 * one-time EventBridge Scheduler schedules live in the per-game group:
 *   open          announced time minus prewarm-minutes → scheduler Lambda
 *                 starts the instance (world resolved NOW, embedded in payload)
 *   countdown-60  persona webhook "opens in an hour" (only if far enough out)
 *   countdown-10  persona webhook "opens in 10 minutes"
 * All carry ActionAfterCompletion=DELETE, so fired schedules self-clean and
 * an empty group means "nothing scheduled".
 */

const schedulerClient = new SchedulerClient({});

const GROUP = process.env.SCHEDULER_GROUP || "";
const TARGET_ARN = process.env.SCHEDULER_TARGET_ARN || "";
const ROLE_ARN = process.env.SCHEDULER_ROLE_ARN || "";
const TZ = process.env.SCHEDULE_TZ || "UTC";

const OPEN_SCHEDULE = "open";
const COUNTDOWN_MINUTES = [60, 10];
const DEFAULT_PREWARM_MINUTES = 10;

const respond = (data: Record<string, unknown>): APIGatewayProxyResult => ({
  statusCode: 200,
  body: JSON.stringify({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data,
  }),
});

const message = (content: string): APIGatewayProxyResult => respond({ content });

export async function handleScheduleCommand(
  action?: string,
  options?: Array<{ name: string; value?: string }>,
  guildId?: string,
): Promise<APIGatewayProxyResult> {
  if (!GROUP || !TARGET_ARN || !ROLE_ARN) {
    return message("❌ Scheduling isn't configured on this deployment (redeploy the stack).");
  }
  try {
    switch (action) {
      case "set": {
        const when = options?.find((o) => o.name === "when")?.value;
        const world = options?.find((o) => o.name === "world")?.value;
        return await handleSet(when, world, guildId);
      }
      case "clear":
        return await handleClear();
      case "list":
        return await handleList();
      default:
        return message(`Unknown schedule action. Use \`${slash} schedule set|clear|list\`.`);
    }
  } catch (error) {
    console.error("Error in handleScheduleCommand:", error);
    return message("❌ Scheduling failed. Please try again.");
  }
}

async function handleSet(
  when?: string,
  worldName?: string,
  guildId?: string,
): Promise<APIGatewayProxyResult> {
  if (!when) {
    return message(
      `Usage: \`${slash} schedule set when:<time> [world:<name>]\` — ` +
      "e.g. `20:00`, `fri 19:30`, `2026-06-13 18:00`.",
    );
  }

  let opensAtEpoch: number;
  try {
    opensAtEpoch = parseWhen(when, TZ, Date.now());
  } catch (err) {
    if (err instanceof WhenParseError) return message(`❌ ${err.message}`);
    throw err;
  }

  // World resolution mirrors /gate start: explicit name, else the guild's
  // configured default — resolved NOW and frozen into the schedule payload.
  let world: WorldConfig | undefined;
  if (worldName) {
    world = WORLD_CONFIGS.find(
      (w) =>
        w.name.toLowerCase() === worldName.toLowerCase() ||
        w.worldName.toLowerCase() === worldName.toLowerCase(),
    );
    if (!world) {
      return message(`❌ World "${worldName}" not found. Use ${slash} worlds to see available worlds.`);
    }
  } else if (guildId) {
    world = await resolveGuildDefaultWorld(guildId);
  }

  const prewarmMinutes = await getPrewarmMinutes();
  const startEpoch = opensAtEpoch - prewarmMinutes * 60_000;
  if (startEpoch <= Date.now() + 60_000) {
    return message(
      `❌ That's less than the ${prewarmMinutes}-minute pre-warm away — just use \`${slash} start\`.`,
    );
  }

  // `set` replaces: one upcoming opening at a time.
  await deleteAllSchedules();

  const base: Omit<ScheduleFireEvent, "action"> = {
    opensAtEpoch,
    guildId,
    world: world ?? null,
  };
  await createOneTimeSchedule(OPEN_SCHEDULE, startEpoch, { ...base, action: "start" });
  for (const minutes of COUNTDOWN_MINUTES) {
    const fireAt = opensAtEpoch - minutes * 60_000;
    // Skip countdowns already in the past (or imminent) for near-term openings.
    if (fireAt > Date.now() + 60_000) {
      await createOneTimeSchedule(`countdown-${minutes}`, fireAt, {
        ...base,
        action: "countdown",
        minutesBefore: minutes,
      });
    }
  }

  const t = Math.floor(opensAtEpoch / 1000);
  const flavor = pickLine(persona.lines?.scheduled, "Opening scheduled.");
  return respond({
    embeds: [personaEmbed({
      title: "📅 Opening Scheduled",
      description:
        `${flavor}\n\n` +
        `The server opens <t:${t}:F> (<t:${t}:R>).\n` +
        `It pre-warms ${prewarmMinutes} minutes early so it's joinable on time; ` +
        "the join details post here when it's ready.",
      color: 0x39a0a0,
      footerSuffix: `${slash} schedule clear to cancel`,
      extra: {
        fields: world ? [{ name: "🌍 World", value: world.name, inline: true }] : [],
        timestamp: new Date().toISOString(),
      },
    })],
  });
}

async function handleClear(): Promise<APIGatewayProxyResult> {
  const deleted = await deleteAllSchedules();
  return message(
    deleted > 0
      ? "🗑️ Scheduled opening cancelled."
      : "Nothing is scheduled.",
  );
}

async function handleList(): Promise<APIGatewayProxyResult> {
  const opening = await getScheduledOpening();
  if (!opening) {
    return message(
      `Nothing is scheduled. Set one with \`${slash} schedule set when:<time>\`.`,
    );
  }
  const t = Math.floor(opening.opensAtEpoch / 1000);
  return respond({
    embeds: [personaEmbed({
      title: "📅 Scheduled Opening",
      description: `The server opens <t:${t}:F> (<t:${t}:R>).`,
      color: 0x39a0a0,
      footerSuffix: `${slash} schedule clear to cancel`,
      extra: {
        fields: opening.worldName
          ? [{ name: "🌍 World", value: opening.worldName, inline: true }]
          : [],
      },
    })],
  });
}

/**
 * The pending opening, if any — also used by /gate status. Reads the "open"
 * schedule's payload (the announced time lives there; the schedule itself
 * fires at the earlier pre-warm instant).
 */
export async function getScheduledOpening(): Promise<
  { opensAtEpoch: number; worldName?: string } | undefined
> {
  if (!GROUP) return undefined;
  try {
    const schedule = await schedulerClient.send(new GetScheduleCommand({
      Name: OPEN_SCHEDULE,
      GroupName: GROUP,
    }));
    const input = schedule.Target?.Input;
    if (!input) return undefined;
    const payload = JSON.parse(input) as ScheduleFireEvent;
    return { opensAtEpoch: payload.opensAtEpoch ?? 0, worldName: payload.world?.name };
  } catch (err) {
    return undefined; // ResourceNotFound = nothing scheduled
  }
}

async function createOneTimeSchedule(
  name: string,
  fireAtEpoch: number,
  payload: ScheduleFireEvent,
): Promise<void> {
  // at() takes a naive timestamp interpreted in ScheduleExpressionTimezone;
  // everything is computed as epoch ms, so hand it UTC.
  const at = new Date(fireAtEpoch).toISOString().slice(0, 19);
  await schedulerClient.send(new CreateScheduleCommand({
    Name: name,
    GroupName: GROUP,
    ScheduleExpression: `at(${at})`,
    ScheduleExpressionTimezone: "UTC",
    FlexibleTimeWindow: { Mode: "OFF" },
    ActionAfterCompletion: "DELETE",
    Target: {
      Arn: TARGET_ARN,
      RoleArn: ROLE_ARN,
      Input: JSON.stringify(payload),
      RetryPolicy: { MaximumRetryAttempts: 3, MaximumEventAgeInSeconds: 300 },
    },
  }));
}

async function deleteAllSchedules(): Promise<number> {
  const list = await schedulerClient.send(new ListSchedulesCommand({ GroupName: GROUP }));
  const names = (list.Schedules ?? []).map((s) => s.Name).filter(Boolean) as string[];
  for (const name of names) {
    try {
      await schedulerClient.send(new DeleteScheduleCommand({ Name: name, GroupName: GROUP }));
    } catch (err) {
      console.log(`Delete of schedule ${name} failed (may have just fired):`, err);
    }
  }
  return names.length;
}

/** The guild's default world: per-guild SSM override first, then worlds-config default. */
async function resolveGuildDefaultWorld(guildId: string): Promise<WorldConfig | undefined> {
  try {
    const result = await ssmClient.send(new GetParameterCommand({
      Name: getGuildDefaultWorldParam(guildId),
    }));
    const name = result.Parameter?.Value;
    if (name) {
      const found = WORLD_CONFIGS.find(
        (w) =>
          w.name.toLowerCase() === name.toLowerCase() ||
          w.worldName.toLowerCase() === name.toLowerCase(),
      );
      if (found) return found;
    }
  } catch (err) {
    // No guild override set — fall through.
  }
  return getDefaultWorldConfig(guildId);
}

async function getPrewarmMinutes(): Promise<number> {
  try {
    const result = await ssmClient.send(new GetParameterCommand({
      Name: SSM_PARAMS.PREWARM_MINUTES,
    }));
    const minutes = parseInt(result.Parameter?.Value ?? "", 10);
    if (Number.isFinite(minutes) && minutes >= 0 && minutes <= 120) return minutes;
  } catch (err) {
    // Param not set — use the default until boot lead time is measured.
  }
  return DEFAULT_PREWARM_MINUTES;
}
