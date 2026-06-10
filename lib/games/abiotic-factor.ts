import { GameProfile } from './types';

/**
 * Abiotic Factor — a Windows dedicated server run under Wine in Docker.
 *
 * Several runtime values are best-effort and marked TODO(verify): confirm them
 * against the upstream image and a local `docker compose` run (Tier 2 testing)
 * before the first AWS deploy. The structure is stable; the strings may move.
 */
export const abioticFactor: GameProfile = {
  id: 'abiotic-factor',
  displayName: 'Abiotic Factor',
  commandName: 'gate', // /gate start | stop | status | hail | join | setup | help
  subdomain: 'abiotic', // abiotic.<BASE_DOMAIN>

  container: {
    // Published image (GitHub Packages). Wine + SteamCMD app 2857200; downloads the
    // server into /server on first boot. Verified against the upstream repo's
    // entrypoint.sh + docker-compose.yml.example.
    image: 'ghcr.io/pleut/abiotic-factor-linux-docker:latest',
    name: 'abiotic-factor-server',
    staticEnv: {
      AutoUpdate: 'true', // re-check for game updates on container start
      UsePerfThreads: 'true',
      NoAsyncLoadingThread: 'true',
      // Port (7777) / QueryPort (27015) / MaxServerPlayers (6) use the image
      // defaults, which match `ports`/`queryPort` below.
    },
    envMap: {
      serverName: 'SteamServerName',
      password: 'ServerPassword',
      worldName: 'WorldSaveName', // dedicated env var; default 'Cascade'
      extraArgs: 'AdditionalArgs',
    },
    // Mirrors the upstream compose: gamefiles -> /server, saves -> /server/AbioticFactor/Saved.
    volumes: [
      { hostPath: '/mnt/game-data/gamefiles', containerPath: '/server' },
      { hostPath: '/mnt/game-data/data', containerPath: '/server/AbioticFactor/Saved' },
    ],
    // Relative to the data volume (/server/AbioticFactor/Saved).
    savePath: 'SaveGames/Server/Worlds',
    // Always-applied: raise the Steam server-registration timeout (default 15s),
    // which fails right after the slow SteamCMD download and prevents A2S from
    // coming up. Combined with a world's extraArgs by the runtime.
    defaultArgs: '-ini:Engine:[OnlineSubsystemSteam]:AsyncTaskTimeout=360',
  },

  ports: [
    { protocol: 'udp', from: 7777, to: 7777 }, // game port
  ],
  queryPort: 27015, // Steam A2S query

  // Wine + a UE5 game wants more headroom than a native server. Override via INSTANCE_TYPE.
  instanceType: 't3.large',
  dataVolumeSizeGb: 20, // SteamCMD pulls several GB for AF

  join: {
    type: 'address',
    port: 7777,
    // AF's Direct Connect dialog takes IP, Port and Password as separate boxes;
    // alternatively the per-session lobby code + password works from Join Game.
    hint: 'In Abiotic Factor: **Join Game → Direct Connect** with the IP, Port and Password below — ' +
      'or enter the Lobby Code + Password instead.',
    // Per-session code printed at startup, e.g. 'LogAbiotic: Warning: Session short code: OKNPD'
    // (verified against the live dedicated server's docker logs).
    codeLogPattern: 'Session short code: [A-Z0-9]+',
  },

  // AF mods live on Nexus (no Thunderstore community / Workshop / headless
  // download API), so the pipeline is: download the zip yourself, `cli mods add`
  // it into the S3 library, list it in a world's `mods`. Only pak patch mods
  // (*_P.pak[/.utoc/.ucas] dropped into Content/Paks) are supported — UE4SS
  // script mods need a pinned loader that's currently broken under Wine, so
  // that kind is deliberately absent until the ecosystem stabilizes.
  mods: {
    kinds: {
      // Inside the gamefiles bind mount (-> /server in the container), next to
      // the base game's pakchunks; the manifest-based installer only ever
      // removes files it copied, so base content is safe.
      pak: { targetPath: '/mnt/game-data/gamefiles/AbioticFactor/Content/Paks' },
    },
    source: { type: 'manual', portalUrl: 'https://www.nexusmods.com/games/abioticfactor' },
    // No server->client sync or handshake: players must install the same pak
    // mods by hand or they desync — /gate mods is the install list.
    clientsMustMatch: true,
  },

  persona: {
    botName: 'GATEKeeper',
    characterName: 'Dr. Derek Manse',
    color: 0x39a0a0, // retro facility teal
    // Dr. Manse hologram, hotlinked from the Abiotic Factor wiki. Verified as a
    // direct image (200 image/png, Cloudflare-served) and not hotlink-blocked for
    // Discord's fetcher; Discord re-caches it on its own proxy. Case-sensitive: the
    // file is `.PNG` (lowercase 404s).
    // TODO(assets-bucket): self-host via the public assets bucket so we don't
    // depend on the wiki keeping this URL stable (see DEVELOPMENT-PLAN.md).
    thumbnailUrl: 'https://abioticfactor.wiki.gg/images/Hologram.PNG',
    footer: 'GATE Cascade Research Facility',
    // First-person, in the voice of Director Manse's facility holograms:
    // authoritative, clinical, faintly condescending.
    hailQuotes: [
      "This is a recorded message from Director Manse. The Cascade facility is online. Kindly avoid touching anything you don't understand — which is, statistically, most of it.",
      "Director Manse speaking. The server is operational. Should you encounter an anomaly, document it. Should it encounter you, the paperwork will be mercifully brief.",
      "Hologram playback initiated. Welcome back to GATE Cascade. Productivity is mandatory; survival is merely encouraged.",
      "Recorded message: the facility is online. Remember — the Order are superstitious idiots. We, by contrast, are insured.",
      "Good day. The server stands ready. Do try to return the timeline in roughly the condition you found it.",
      "Director Manse here — or a recording thereof; I am a busy man. Containment is nominal. Mostly.",
      "Facility systems online. Reminder: unauthorized portal travel is grounds for termination. Of employment, and otherwise.",
      "This message was pre-recorded. If I am no longer available, that is, regrettably, none of your concern. The server, however, is up.",
      "Welcome, employee. The Cascade facility is operational. Your enthusiasm is noted and, frankly, suspicious.",
      "Server online. Should you require assistance, consult a colleague. Should they require assistance, you are evidently the senior staff now.",
    ],
  },
};
