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

  const { status, publicIp } = await getFastServerStatus();
  if (status !== "running") {
    return respond({
      embeds: [personaEmbed({
        title: "🔌 Join the server",
        description: `The server is not running (status: ${status}).\n` +
          `Start it with \`${slash} start\`, then run \`${slash} join\` once it's live.`,
      })],
    });
  }

  // Instance up but the game still loading: connecting fails and any join code
  // in SSM would be last session's, so hold the details until the monitor flips
  // server-live (it keeps scraping the code even in a private session).
  if (!(await getServerLive())) {
    return respond({
      embeds: [personaEmbed({
        title: "🔌 Join the server",
        description: "The server is powering up but the game is still loading — " +
          `try \`${slash} join\` again in a moment.`,
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

  // Render the full per-game join set (address/port/password/join code) for BOTH
  // address games and join-code games (Valheim). Crucial for private sessions:
  // the readiness ping is suppressed, so /<cmd> join is the ONLY way to get the
  // code — buildJoinFields reads it from SSM (the host still scrapes it).
  const fallbackDesc = join.type === "address"
    ? `Connect in-game to \`${host}:${join.port}\``
    : "Connect with the details below.";
  return respond({
    embeds: [personaEmbed({
      title: "🔌 Join the server",
      description: (joinHint() ?? fallbackDesc) + privateNote,
      extra: { fields: await buildJoinFields(host) },
    })],
  });
}
