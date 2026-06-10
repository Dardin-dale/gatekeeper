import { GameProfile } from './types';
import { abioticFactor } from './abiotic-factor';
import { valheim } from './valheim';

export * from './types';

/** Registry of supported game plugins, keyed by GameProfile.id. */
export const GAME_PROFILES: Record<string, GameProfile> = {
  [abioticFactor.id]: abioticFactor,
  [valheim.id]: valheim,
};

export const DEFAULT_GAME = 'abiotic-factor';

/**
 * Resolve the active game profile. Defaults to the GAME env var, then to AF.
 * Throws on an unknown id so a misconfigured deploy fails loudly, not silently.
 */
export function getGameProfile(id: string = process.env.GAME || DEFAULT_GAME): GameProfile {
  const profile = GAME_PROFILES[id];
  if (!profile) {
    const known = Object.keys(GAME_PROFILES).join(', ');
    throw new Error(`Unknown GAME '${id}'. Known games: ${known}`);
  }
  return profile;
}

/** The profile selected for this process/deploy (via the GAME env var). */
export const ACTIVE_GAME: GameProfile = getGameProfile();

/**
 * The runtime-relevant subset of a profile, emitted verbatim to
 * `game-profile.json` and read by the EC2 start script with `jq`. This is the
 * single bridge between the TypeScript profile and the host bash runtime —
 * everything the `docker run` needs (image, env mapping, volumes, ports) and
 * nothing else (no persona, no instance sizing — those are build-time only).
 */
export function runtimeProfile(profile: GameProfile = ACTIVE_GAME) {
  return {
    id: profile.id,
    displayName: profile.displayName, // presence sidecar's "Playing <name>"
    image: profile.container.image,
    containerName: profile.container.name,
    staticEnv: profile.container.staticEnv,
    envMap: profile.container.envMap,
    volumes: profile.container.volumes,
    savePath: profile.container.savePath,
    defaultArgs: profile.container.defaultArgs ?? '',
    ports: profile.ports,
    queryPort: profile.queryPort,
    // ERE for the per-session lobby/join code in container logs (empty = none).
    // The monitor scrapes it at first liveness and writes it to SSM — for
    // address games with an optional code (AF) AND join-code games (Valheim).
    joinCodePattern: profile.join.type === 'address'
      ? (profile.join.codeLogPattern ?? '')
      : profile.join.logPattern,
    // A2S fallback: log-scraped liveness/player count (see types.ts).
    playersLogPattern: profile.playersLogPattern ?? '',
    // Join details for the host's readiness embed, so "🟢 Server Online" renders
    // the same port + hint as /gate join and /gate status (util/join-info).
    join: profile.join.type === 'address'
      ? { type: 'address', port: profile.join.port, hint: profile.join.hint ?? '',
          codeLabel: profile.join.codeLabel ?? 'Join Code' }
      : { type: profile.join.type, hint: profile.join.hint ?? '',
          codeLabel: profile.join.codeLabel ?? 'Join Code',
          addressWithPort: profile.join.addressWithPort ?? false },
    // Mod install kinds: metadata `kind` -> { targetPath, env? }. The start
    // script syncs each of the active world's mods (from the S3 library) into
    // its kind's targetPath and applies the kind env. Empty = game unmodded.
    modKinds: profile.mods?.kinds ?? {},
    // Just enough persona for the host's webhook posts to come from the character
    // in full (e.g. Dr. Derek Manse) with his avatar — matches the lambda embeds.
    persona: {
      characterName: profile.persona.characterName,
      thumbnailUrl: profile.persona.thumbnailUrl ?? '',
      footer: profile.persona.footer,
    },
  };
}

/**
 * Full host for a game under the shared base domain. One hosted zone, one
 * derived record per game — e.g. gameDomain('gjurdsihop.net') -> 'abiotic.gjurdsihop.net'.
 * Returns undefined when no base domain is configured.
 */
export function gameDomain(
  baseDomain: string | undefined = process.env.BASE_DOMAIN,
  profile: GameProfile = ACTIVE_GAME,
): string | undefined {
  if (!baseDomain) return undefined;
  return `${profile.subdomain ?? profile.id}.${baseDomain}`;
}
