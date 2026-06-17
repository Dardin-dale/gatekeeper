import { APIGatewayProxyResult } from "aws-lambda";
import { GetParameterCommand, PutParameterCommand } from "@aws-sdk/client-ssm";
import { ssmClient, withRetry } from "../utils/aws-clients";
import { notifyCategories, getNotifyParam } from "../utils/params";
import { persona, slash, personaEmbedResponse } from "./util/persona";

const embed = (title: string, description: string, color: number, footerSuffix?: string): APIGatewayProxyResult =>
  personaEmbedResponse(title, description, color, { footerSuffix });

/** Current on/off state of a category; default ON when the SSM param is unset. */
async function getState(category: string): Promise<boolean> {
  try {
    const r = await withRetry(() => ssmClient.send(new GetParameterCommand({ Name: getNotifyParam(category) })));
    return r.Parameter?.Value !== "off";
  } catch {
    return true; // unset / not found -> enabled by default
  }
}

/**
 * `/<cmd> notify set <category> <on|off>` and `/<cmd> notify list` — toggle which
 * host->Discord notifications fire. Stored as SSM /gatekeeper/<game>/notify/<cat>
 * (read by the on-host post_discord). Subcommand group, dispatched like schedule.
 */
export async function handleNotifyCommand(action?: string, options?: any[]): Promise<APIGatewayProxyResult> {
  try {
    const categories = notifyCategories();
    if (action === "set") {
      const category = options?.find((o: any) => o.name === "category")?.value as string | undefined;
      const state = options?.find((o: any) => o.name === "state")?.value as string | undefined;
      const cat = categories.find((c) => c.key === category);
      if (!cat || (state !== "on" && state !== "off")) {
        return embed("❌ Invalid Setting", `Pick a category and \`on\`/\`off\`. See \`${slash} notify list\`.`, 0xff0000);
      }
      await withRetry(() => ssmClient.send(new PutParameterCommand({
        Name: getNotifyParam(cat.key),
        Value: state,
        Type: "String",
        Overwrite: true,
      })));
      return embed(
        state === "off" ? "🔕 Notification Silenced" : "🔔 Notification Enabled",
        `**${cat.label}** posts are now **${state === "off" ? "off" : "on"}**.`,
        persona.color,
        `See all with ${slash} notify list`,
      );
    }

    // list (default)
    const lines = await Promise.all(
      categories.map(async (c) => `${(await getState(c.key)) ? "🔔" : "🔕"} \`${c.key}\` — ${c.label}`),
    );
    return embed(
      "🔔 Notification Settings",
      lines.join("\n"),
      persona.color,
      `Toggle with ${slash} notify set <category> on|off`,
    );
  } catch (error) {
    console.error("Error in handleNotifyCommand:", error);
    return embed("❌ Couldn't Update Notifications", "Please try again in a moment.", 0xff0000, "Contact admin if this persists");
  }
}
