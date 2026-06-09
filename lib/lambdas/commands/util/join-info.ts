import { GetParameterCommand } from "@aws-sdk/client-ssm";
import { ssmClient, SSM_PARAMS } from "../../utils/aws-clients";
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
 * address / port / password (spoiler-wrapped) / per-session lobby code,
 * each as a copyable fenced block. Empty for join-code-only games (their
 * code is posted to the channel by the host monitor).
 */
export async function buildJoinFields(host: string): Promise<EmbedField[]> {
  if (ACTIVE_GAME.join.type !== "address") return [];

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

  return [
    { name: "🌐 Address", value: copyable(host), inline: true },
    { name: "🔌 Port", value: copyable(ACTIVE_GAME.join.port), inline: true },
    // Spoiler-wrapped so screenshots/streams don't leak it — click to reveal.
    ...(password ? [{ name: "🔑 Password", value: `||${copyable(password)}||`, inline: true }] : []),
    ...(lobbyCode ? [{ name: "🎟️ Lobby Code", value: copyable(lobbyCode), inline: true }] : []),
  ];
}
