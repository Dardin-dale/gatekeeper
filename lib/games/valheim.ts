import { GameProfile } from './types';

/**
 * Valheim — the GATEKeeper port of huginbot. Personified as MUNIN (memory, the
 * other of Odin's ravens) rather than Hugin so it can run side-by-side with the
 * live huginbot during migration: distinct Discord app, distinct /munin command,
 * zero namespace overlap. Deploy with GAME=valheim -> GateStack-Valheim; retire
 * huginbot once worlds are migrated (docs/GAME-CANDIDATES.md has the checklist).
 */
export const valheim: GameProfile = {
  id: 'valheim',
  displayName: 'Valheim',
  commandName: 'munin', // /munin start | stop | status | hail | join | setup | help
  subdomain: 'valheim', // valheim.<BASE_DOMAIN>

  container: {
    image: 'ghcr.io/community-valheim-tools/valheim-server',
    name: 'valheim-server',
    staticEnv: {},
    envMap: {
      serverName: 'SERVER_NAME',
      worldName: 'WORLD_NAME',
      password: 'SERVER_PASS',
      // Space-separated SteamID64s -> the image writes adminlist.txt.
      adminIds: 'ADMINLIST_IDS',
      extraArgs: 'SERVER_ARGS',
    },
    volumes: [{ hostPath: '/mnt/game-data/config', containerPath: '/config' }],
    savePath: 'worlds_local', // /config/worlds_local
  },

  ports: [
    { protocol: 'udp', from: 2456, to: 2458 },
    { protocol: 'tcp', from: 2456, to: 2458 },
  ],
  queryPort: 2457,

  instanceType: 't3.medium',
  dataVolumeSizeGb: 12,

  // ⚠️ With -crossplay (our worlds use it) Valheim switches to PlayFab
  // networking and does NOT answer A2S on 2457 — verified live on the first
  // GateStack-Valheim boot. Liveness + player count come from the log instead,
  // and they need DIFFERENT lines (the source of a real idle-shutdown bug that
  // kicked a mid-session player):
  //   - COUNT: the join/leave EVENT lines, which carry the live count and are
  //     proven accurate under crossplay ("Player joined server ... now 1
  //     player(s)" / "Player connection lost server ... now 0 player(s)").
  //     The host reads the full log, so the latest event = current count even
  //     for a player who joined long ago and is sitting quietly.
  //   - LIVENESS: the recurring session heartbeat ("Session ... is active with
  //     N player(s)"), which fires even at 0 players the moment the PlayFab
  //     session registers. NOT used for the count: under crossplay it can be
  //     PlayFab-blind and report a stale 0, which would idle-kill a live player.
  playersLogPattern: 'now [0-9]+ player',
  livenessLogPattern: 'is active with [0-9]+ player',

  // Flavor posts (gated by the `events` notify toggle). Munin "remembers every
  // death" — now he actually does. Deaths carry the name (ZDOID 0:0 = death/
  // unload, so an occasional logoff reads as a death — on-brand for Munin);
  // join/leave don't (Valheim's join line names the server, not the player).
  events: [
    {
      id: 'death',
      pattern: 'Got character ZDOID from .+ : 0:0',
      nameSed: 's/.*Got character ZDOID from (.+) : 0:0.*/\\1/',
      title: '☠️ {name} has fallen',
      body: 'Another name for the saga. I remember them all — the deaths most of all.',
    },
    {
      id: 'raid',
      // "... Random event set:army_theelder" — start of a raid/world event.
      pattern: 'Random event set:[a-z_]+',
      title: '⚔️ A raid descends on the hall!',
      body: 'The wilds stir against you. Steel yourselves and defend what you have built.',
    },
    {
      id: 'join',
      pattern: 'Player joined server .* now [0-9]+ player',
      title: '🛡️ A viking enters the hall',
    },
    {
      id: 'leave',
      pattern: 'Player connection lost server .* now [0-9]+ player',
      title: '🚪 A viking departs the hall',
    },
  ],

  // In practice players save the server once and reuse it: Steam → View →
  // Game Servers → Favorites with <domain>:2457 remembers the password after
  // the first join — the derived domain makes that favorite stable.
  join: {
    type: 'join-code',
    // The scraper takes the last token of the latest MATCH (grep -oE), so the
    // pattern must include the digits: "... registered with join code 487341".
    logPattern: 'join code [0-9]+',
    codeLabel: 'Join Code', // Valheim's crossplay UI wording
    addressWithPort: true,  // Valheim's add-server box takes one "host:port" string
    hint: 'Save the server in Steam favorites (View → Game Servers → Favorites) using its address — ' +
      'Steam remembers the password after the first join. Or use the crossplay join code posted ' +
      'here when the server comes online.',
  },

  // The huginbot model, expressed as a ModsSpec: BepInEx plugin .dlls synced
  // into /config/bepinex/plugins (the image installs BepInEx itself when
  // BEPINEX=true), imported headlessly from Thunderstore by `cli mods import`.
  mods: {
    kinds: {
      'bepinex-plugin': {
        targetPath: '/mnt/game-data/config/bepinex/plugins',
        env: { BEPINEX: 'true' },
      },
    },
    source: { type: 'thunderstore', community: 'valheim' },
  },

  persona: {
    botName: 'MuninBot',
    characterName: 'Munin',
    color: 0x8b0000, // dark red — Muninn, Odin's raven of memory; distinct from huginbot's purple
    // Munin art from the Valheim wiki — verified a direct image (200 image/webp,
    // not hotlink-blocked). TODO(assets-bucket): self-host alongside the Manse
    // hologram when the public assets bucket lands.
    thumbnailUrl: 'https://static.wikia.nocookie.net/valheim/images/5/52/Munin.png',
    footer: 'Memory of the All-Father',
    lines: {
      starting: 'The ravens take wing — your world is waking.',
      offline: 'The world sleeps. Every deed is remembered.',
      scheduled: [
        'It is decided. The hall opens at the appointed hour — Odin has marked the time, and so have I.',
        'The longship is provisioned and the hour is set. Valhalla can wait a little longer.',
        'So it is written in the runes (and in the schedule). I will not let you forget — remembering is rather my whole purpose.',
      ],
      countdown: [
        'The hall opens soon. Sharpen your axes, braid your beards, hide from the bees.',
        'Hugin flies ahead — the brazier is lit and the mead is poured. Soon.',
        'Soon the serpent stirs and the hall stands open. Do not keep the Allfather waiting.',
        'The ravens circle the meadhall. Gather your wood, warriors — you always need more wood.',
      ],
    },
    // Munin is memory to Hugin's thought: he remembers, records, and recalls.
    hailQuotes: [
      'Hrafn! I am Munin — Hugin thinks, I remember. Your worlds are safe in my keeping.',
      'The All-Father fears most to lose me, for memory outlasts thought. Your saves agree.',
      'I remember every raid, every death, every backup. Especially the deaths.',
      'Skål! The mead hall stands where you left it — I made sure of it.',
      'My brother scouts ahead; I keep the ledger. The server answers when you call.',
      'Odin sends two ravens over Midgard. You got the one with the better records.',
      'Memory of the All-Father, at your service. Nothing of your world is forgotten.',
    ],
  },
};
