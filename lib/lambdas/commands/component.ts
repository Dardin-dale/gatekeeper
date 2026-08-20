import { APIGatewayProxyResult } from "aws-lambda";
import { GetParameterCommand, PutParameterCommand, SendCommandCommand } from "@aws-sdk/client-ssm";
import { ssmClient, withRetry, SERVER_INSTANCE_ID } from "../utils/aws-clients";
import { SSM_PARAMS, getExtendMinutes } from "../utils/params";
import { InteractionResponseType } from "./types";
import { handleStatusCommand } from "./status";
import { handleStopCommand } from "./stop";
import { handleOpenCommand } from "./open";

// ---------------------------------------------------------------------------
// Status-message buttons. These custom_ids / styles MUST stay in sync with the
// button rows the host emits in scripts/game/monitor.sh (build_payload), since a
// Cancel here re-renders the same live-controls row the host first posted.
//   gk_stop  → confirm row → gk_stop_confirm / gk_stop_cancel   (two-click guard)
//   gk_extend → adds idle grace          gk_open → flip private session public
//   gk_restart → re-run the game server unit (failed-boot message only)
// ---------------------------------------------------------------------------
const BTN_STOP = { type: 2, style: 4, label: "🛑 Stop", custom_id: "gk_stop" };
const BTN_EXTEND = { type: 2, style: 1, label: "⏰ Extend", custom_id: "gk_extend" };
const BTN_CONFIRM = { type: 2, style: 4, label: "⚠️ Confirm stop", custom_id: "gk_stop_confirm" };
const BTN_CANCEL = { type: 2, style: 2, label: "Cancel", custom_id: "gk_stop_cancel" };

/** Wrap buttons in a single action row (Discord's components container). */
function row(...buttons: unknown[]): unknown[] {
  return [{ type: 1, components: buttons }];
}

/** Live-controls row: Stop always; Extend only while the idle clock runs (0 players)
 *  and the feature is enabled — mirrors the host's live_controls() in monitor.sh. */
function liveControls(playerCount: number, extendOff: boolean): unknown[] {
  return playerCount >= 1 || extendOff ? row(BTN_STOP) : row(BTN_STOP, BTN_EXTEND);
}

async function getPlayerCount(): Promise<number> {
  try {
    const r = await ssmClient.send(new GetParameterCommand({ Name: SSM_PARAMS.PLAYER_COUNT }));
    const n = parseInt(r.Parameter?.Value ?? "", 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** UPDATE_MESSAGE keeping the existing embeds, swapping only the button row. */
function swapButtons(body: any, components: unknown[]): APIGatewayProxyResult {
  return {
    statusCode: 200,
    body: JSON.stringify({
      type: InteractionResponseType.UPDATE_MESSAGE,
      data: { embeds: body.message?.embeds ?? [], components },
    }),
  };
}

/** Ephemeral ack to the clicker (a private message); the status message is untouched. */
function ephemeralAck(content: string): APIGatewayProxyResult {
  return {
    statusCode: 200,
    body: JSON.stringify({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content, flags: 64 },
    }),
  };
}

export async function handleComponentInteraction(body: any): Promise<APIGatewayProxyResult> {
  const customId: string | undefined = body.data?.custom_id;
  const guildId: string | undefined = body.guild_id;

  switch (customId) {
    case "status_refresh":
      return await handleStatusCommand();

    // Open: flip a private session public. Lives on the /start ephemeral reply.
    case "gk_open":
      return await handleOpenCommand(guildId);

    // Stop, first click: ask to confirm in place (swap buttons only, keep the embed).
    case "gk_stop":
      return swapButtons(body, row(BTN_CONFIRM, BTN_CANCEL));

    // Stop, cancelled: restore the live controls (Extend shown only if still idle
    // and the feature is enabled).
    case "gk_stop_cancel": {
      const [count, minutes] = await Promise.all([getPlayerCount(), getExtendMinutes()]);
      return swapButtons(body, liveControls(count, minutes === "off"));
    }

    // Stop, confirmed: trigger backup-and-stop, then flip THIS message into the
    // "stopping" state and drop the buttons. The offline lambda later edits it to
    // the final Offline state (one message across the whole lifecycle).
    case "gk_stop_confirm":
      await handleStopCommand(guildId, false); // side effect: backup-and-stop
      return stoppingTransition(body);

    case "gk_extend":
      return await handleExtendButton();

    // Restart, offered only on a failed-boot status message: re-runs the game
    // server unit, which re-attempts the update that failed. Cheap and safe
    // (the instance and the data volume are untouched), so it needs no confirm
    // step — unlike Stop, a mis-click here costs a couple of minutes, not a
    // session. If it fails a second time the files need a manual reinstall.
    case "gk_restart":
      return await handleRestartButton();

    default:
      // Unknown / future button — ack silently so Discord doesn't show an error.
      return {
        statusCode: 200,
        body: JSON.stringify({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE }),
      };
  }
}

/**
 * Restart the game server container in place: `systemctl restart game-server` on
 * the host, which re-runs the image entrypoint (and therefore the update step
 * that failed). Fire-and-forget — the host monitor takes over reporting from
 * there, republishing boot phases into this same status message.
 */
async function handleRestartButton(): Promise<APIGatewayProxyResult> {
  try {
    await withRetry(() => ssmClient.send(new SendCommandCommand({
      DocumentName: "AWS-RunShellScript",
      InstanceIds: [SERVER_INSTANCE_ID],
      Parameters: { commands: ["systemctl restart game-server"] },
      Comment: "Restart triggered from a failed-boot status message",
    })));
  } catch (err) {
    console.error("Restart command failed to dispatch:", err);
    return ephemeralAck(
      "⚠️ Couldn't reach the server host to restart it. It may already be shutting down — " +
      "check with `status`.",
    );
  }
  return ephemeralAck(
    "🔄 Restarting the server — it re-runs the game update on the way up. " +
    "Progress posts to the status message; it usually takes a few minutes.",
  );
}

/**
 * Re-render the clicked status message into the amber "stopping" state, reusing
 * its constant title/footer/thumbnail so it reads as the same message updating.
 * Drops the join fields and all buttons.
 */
function stoppingTransition(body: any): APIGatewayProxyResult {
  const prev = body.message?.embeds?.[0] ?? {};
  const embed: Record<string, unknown> = {
    ...prev,
    description: "💤 Stopping — backing up & shutting down…",
    color: 0xffc870, // amber, matches the host's Winding Down
  };
  delete (embed as any).fields; // join details no longer apply
  return {
    statusCode: 200,
    body: JSON.stringify({
      type: InteractionResponseType.UPDATE_MESSAGE,
      data: { embeds: [embed], components: [] },
    }),
  };
}

/** Extend: push idle auto-shutdown out by the per-game extend window (SSM signal). */
async function handleExtendButton(): Promise<APIGatewayProxyResult> {
  const minutes = await getExtendMinutes();
  if (minutes === "off") {
    return ephemeralAck("⏰ Extend is turned off for this game.");
  }
  try {
    const until = Date.now() + minutes * 60_000;
    await withRetry(() => ssmClient.send(new PutParameterCommand({
      Name: SSM_PARAMS.EXTEND_UNTIL,
      Value: String(until),
      Type: "String",
      Overwrite: true,
    })));
    return ephemeralAck(`⏰ Added ${minutes} min — auto-shutdown is held off until then.`);
  } catch (err) {
    console.error("Error in handleExtendButton:", err);
    return ephemeralAck("⏰ Couldn't extend — try again in a moment.");
  }
}
