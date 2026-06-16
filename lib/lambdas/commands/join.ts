import { APIGatewayProxyResult } from "aws-lambda";
import { InteractionResponseType } from "./types";
import { ACTIVE_GAME } from "../../games";
import { getFastServerStatus, getServerLive, getSessionPrivate } from "../utils/aws-clients";
import { personaEmbed, slash } from "./util/persona";
import { buildJoinFields, joinHost, joinHint } from "./util/join-info";

/**
 * /gate join — how to connect. The join strategy is game-dependent and comes
 * from the profile's `join` discriminated union; the actual field rendering
 * (address/port/password/lobby code) is shared with /gate status via
 * util/join-info so both always show the same per-game format.
 *
 * Reply visibility auto-follows the session: during a private session the reply
 * is ephemeral so the join details stay off the channel — that's how friends
 * join a quiet session. Public sessions reply publicly as usual.
 */
export async function handleJoinCommand(): Promise<APIGatewayProxyResult> {
  const join = ACTIVE_GAME.join;
  const sessionPrivate = await getSessionPrivate();
  const ephemeral = sessionPrivate;

  const respond = (data: Record<string, unknown>): APIGatewayProxyResult => ({
    statusCode: 200,
    body: JSON.stringify({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { ...data, ...(ephemeral ? { flags: 64 } : {}) },
    }),
  });
  // Mark the reply when the SESSION (not just this reply) is private, so the
  // player knows there's no public announcement and the details are theirs.
  const privateNote = sessionPrivate ? "\n\n🔒 Private session — these details are just for you." : "";

  if (join.type !== "address") {
    return respond({
      embeds: [personaEmbed({
        title: "🔌 Join the server",
        description: join.hint ??
          "This game uses a join code — it's posted to this channel when the server is ready.",
      })],
    });
  }

  const { status, publicIp } = await getFastServerStatus();
  if (status !== "running") {
    return respond({
      embeds: [personaEmbed({
        title: "🔌 Join the server",
        description: `The server is not running (status: ${status}).\n` +
          `Start it with \`${slash} start\` — the join address is posted here when it's ready.`,
      })],
    });
  }

  // Instance up but the game still loading: connecting fails and any join code
  // in SSM would be last session's, so hold the details until the monitor
  // flips server-live (the readiness ping posts them anyway).
  if (!(await getServerLive())) {
    return respond({
      embeds: [personaEmbed({
        title: "🔌 Join the server",
        description: "The server is powering up but the game is still loading — " +
          "the join details are posted here the moment it's joinable.",
      })],
    });
  }

  const host = joinHost(publicIp);
  if (!host) {
    return respond({
      embeds: [personaEmbed({
        title: "🔌 Join the server",
        description: "The server is starting but has no public address yet — try again in a moment.",
      })],
    });
  }

  return respond({
    embeds: [personaEmbed({
      title: "🔌 Join the server",
      description: (joinHint() ?? `Connect in-game to \`${host}:${join.port}\``) + privateNote,
      extra: { fields: await buildJoinFields(host) },
    })],
  });
}
