import { APIGatewayProxyResult } from "aws-lambda";
import { GetParameterCommand } from "@aws-sdk/client-ssm";
import { InteractionResponseType } from "./types";
import { ACTIVE_GAME, gameDomain } from "../../games";
import { getFastServerStatus, ssmClient, SSM_PARAMS } from "../utils/aws-clients";
import { personaEmbed } from "./util/persona";

/**
 * /gate join — how to connect. The join strategy is game-dependent and comes
 * from the profile's `join` discriminated union:
 *   - { type: 'address', port, hint? }   (Abiotic Factor): report the host
 *     (derived domain ?? instance public IP), port and the active world's
 *     password as SEPARATE fields — direct-connect dialogs ask for them
 *     separately — with the game's own connect instructions from `hint`.
 *   - { type: 'join-code', ... }  (Valheim-style): the code is detected on-host
 *     and posted to the channel; this command just points players there.
 */
export async function handleJoinCommand(): Promise<APIGatewayProxyResult> {
  const join = ACTIVE_GAME.join;

  const respond = (data: Record<string, unknown>): APIGatewayProxyResult => ({
    statusCode: 200,
    body: JSON.stringify({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data,
    }),
  });

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
        description: `The server is not running (status: ${status}). ` +
          `Start it with \`/gate start\` — the join address is posted here when it's ready.`,
      })],
    });
  }

  // Prefer the stable derived domain; fall back to the current public IP.
  const host = gameDomain() ?? publicIp;
  if (!host) {
    return respond({
      embeds: [personaEmbed({
        title: "🔌 Join the server",
        description: "The server is starting but has no public address yet — try again in a moment.",
      })],
    });
  }

  // The active world's password (players need it for direct connect).
  let password: string | undefined;
  try {
    const result = await ssmClient.send(new GetParameterCommand({
      Name: SSM_PARAMS.ACTIVE_WORLD,
    }));
    if (result.Parameter?.Value) {
      password = JSON.parse(result.Parameter.Value).serverPassword || undefined;
    }
  } catch (err) {
    console.log("No active world in SSM; omitting password from join info");
  }

  const fields = [
    { name: "🌐 IP / Address", value: `\`${host}\``, inline: true },
    { name: "🔌 Port", value: `\`${join.port}\``, inline: true },
    ...(password ? [{ name: "🔑 Password", value: `\`${password}\``, inline: true }] : []),
  ];

  return respond({
    embeds: [personaEmbed({
      title: "🔌 Join the server",
      description: join.hint ?? `Connect in-game to \`${host}:${join.port}\``,
      extra: { fields },
    })],
  });
}
