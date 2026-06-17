import { GetParameterCommand } from "@aws-sdk/client-ssm";
import { ssmClient } from "../../utils/aws-clients";
import { SSM_PARAMS } from "../../utils/params";
import { ACTIVE_GAME, gameDomain } from "../../../games";

export interface EmbedField {
  name: string;
  value: string;
  inline: boolean;
}

// Fenced code blocks get Discord's native Copy button (hover on desktop,
// long-press on mobile) — single backticks don't.
const copyable = (v: string | number) => `\`\`\`\n${v}\n\`\`\``;

/** Host for address-type joins: the stable derived domain, else the current public IP. */
export function joinHost(publicIp?: string): string | undefined {
  return gameDomain() ?? publicIp;
}

/** The game's own connect instructions (which menu, what the fields are called). */
export function joinHint(): string | undefined {
  return ACTIVE_GAME.join.hint;
}

/**
 * The game's join info as embed fields — the ONE place the per-game join
 * format is rendered, shared by /gate join and /gate status:
 * address / port / password (spoiler-wrapped) / per-session join code,
 * each as a copyable fenced block. Join-code games get the SAME full set —
 * address+password serve direct connect / Steam favorites, the code serves
 * crossplay — so nothing about how to join lives only in the readiness ping.
 */
export async function buildJoinFields(host: string): Promise<EmbedField[]> {
  const joinPort = ACTIVE_GAME.join.type === "address"
    ? ACTIVE_GAME.join.port
    : ACTIVE_GAME.ports[0].from;

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

  // Per-session lobby code, scraped from the server logs by the host monitor.
  let lobbyCode: string | undefined;
  try {
    const result = await ssmClient.send(new GetParameterCommand({
      Name: SSM_PARAMS.JOIN_CODE,
    }));
    const value = result.Parameter?.Value;
    if (value && value !== "none") lobbyCode = value;
  } catch (err) {
    console.log("No join code in SSM");
  }

  // Games whose connect box takes one "host:port" string (Valheim) get it
  // pre-joined as a single copyable; others keep separate Address/Port fields.
  const withPort = ACTIVE_GAME.join.type === "join-code" && ACTIVE_GAME.join.addressWithPort;

  return [
    // Full-width: domains don't fit Discord's narrow 3-per-row inline fields
    // without ugly wrapping inside the code block.
    { name: "🌐 Address", value: copyable(withPort ? `${host}:${joinPort}` : host), inline: false },
    ...(withPort ? [] : [{ name: "🔌 Port", value: copyable(joinPort), inline: true }]),
    // Spoiler-wrapped so screenshots/streams don't leak it — click to reveal.
    ...(password ? [{ name: "🔑 Password", value: `||${copyable(password)}||`, inline: true }] : []),
    // Label is per-game UI wording: AF says "Lobby Code", Valheim "Join Code".
    ...(lobbyCode
      ? [{ name: `🎟️ ${ACTIVE_GAME.join.codeLabel ?? "Join Code"}`, value: copyable(lobbyCode), inline: true }]
      : []),
  ];
}
