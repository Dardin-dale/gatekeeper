import { APIGatewayProxyResult } from "aws-lambda";
import { GetParameterCommand, PutParameterCommand } from "@aws-sdk/client-ssm";
import { ssmClient, withRetry } from "../utils/aws-clients";
import { SSM_PARAMS } from "../utils/params";
import { persona, slash, personaEmbedResponse } from "./util/persona";
import { requireOwner } from "./util/owner";

// The owner-tunable cost-guardrail timers. Discord `key` choice -> the SSM param
// the on-host monitor re-reads each cycle, plus its deploy-time default (for the
// "param unset" display). Mirrors `cli config` and KNOBS in cli/commands/config.js.
const KNOBS: Record<string, { param: string; def: string; label: string }> = {
  "auto-shutdown": { param: SSM_PARAMS.AUTO_SHUTDOWN_MINUTES, def: "15", label: "Idle auto-shutdown" },
  "boot-timeout": { param: SSM_PARAMS.BOOT_TIMEOUT_MINUTES, def: "45", label: "Boot-timeout" },
};

// Owner-only admin surface — replies are ephemeral (private to the caller), so
// cost-tuning never clutters the channel.
const embed = (title: string, description: string, color: number, footerSuffix?: string): APIGatewayProxyResult =>
  personaEmbedResponse(title, description, color, { footerSuffix, ephemeral: true });

/** Current value of a timer param, or undefined when unset (shows the default). */
async function getValue(param: string): Promise<string | undefined> {
  try {
    const r = await withRetry(() => ssmClient.send(new GetParameterCommand({ Name: param })));
    return r.Parameter?.Value;
  } catch {
    return undefined;
  }
}

function describe(value: string): string {
  return value === "off" || value === "disabled" ? "disabled" : `${value} min idle/boot`;
}

/**
 * `/<cmd> config show | set` — owner-only tuning of the cost-guardrail timers
 * (idle auto-shutdown + boot-timeout), stored as the SSM params the monitor
 * re-reads each cycle. Owner-gated because these spend the owner's AWS money;
 * the whole group is gated (show included — it's an admin view). Disabling a
 * guard stays CLI-only on purpose (a forgotten `off` bills indefinitely).
 */
export async function handleConfigCommand(action: string | undefined, options: any[] | undefined, interaction: any): Promise<APIGatewayProxyResult> {
  const denied = requireOwner(interaction);
  if (denied) return denied;

  try {
    if (action === "set") {
      const key = options?.find((o: any) => o.name === "key")?.value as string | undefined;
      const minutes = options?.find((o: any) => o.name === "minutes")?.value as number | undefined;
      const knob = key ? KNOBS[key] : undefined;
      if (!knob || typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 1) {
        return embed("❌ Invalid Setting", `Pick a timer and a positive number of minutes. See \`${slash} config show\`.`, 0xff0000);
      }
      await withRetry(() => ssmClient.send(new PutParameterCommand({
        Name: knob.param,
        Value: String(minutes),
        Type: "String",
        Overwrite: true,
      })));
      return embed(
        "⏱️ Timer Updated",
        `**${knob.label}** is now **${minutes} min**.\nThe server picks it up within ~one monitor cycle — no restart.`,
        persona.color,
        `Owner-only · to disable a guard use the CLI (cli config set ${key} off)`,
      );
    }

    // show (default)
    const lines = await Promise.all(
      Object.entries(KNOBS).map(async ([key, knob]) => {
        const val = await getValue(knob.param);
        const shown = val === undefined ? `${knob.def} (default)` : describe(val);
        return `\`${key}\` — ${knob.label}: **${shown}**`;
      }),
    );
    return embed(
      "⏱️ Cost-Guardrail Timers",
      lines.join("\n"),
      persona.color,
      `Owner-only · set with ${slash} config set <timer> <minutes>`,
    );
  } catch (error) {
    console.error("Error in handleConfigCommand:", error);
    return embed("❌ Couldn't Update Timers", "Please try again in a moment.", 0xff0000, "Contact the owner if this persists");
  }
}
