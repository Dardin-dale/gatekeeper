import { GameProfile, GameEvent } from './types';

// Valheim raid/world-event lines are `Random event set:<id>`. Each id gets a
// Munin-voiced banner (the game already shows its own banner, so this is flavor).
// All share the one 'raid' notify category. event_id -> Munin line; `blobs` has
// no in-game banner and is omitted; `bats` is medium-confidence but harmless if
// the id never appears. (Mapping verified against the Valheim event list.)
const valheimRaids: GameEvent[] = (
  [
    ['army_eikthyr', 'Eikthyr rouses the forest — its beasts come for you. I have seen this hunt before.'],
    ['army_theelder', 'The forest is moving. Hold fast; I will remember who stood their ground.'],
    ['army_bonemass', 'A foul reek rises from the swamp. Something old has woken — and it remembers you.'],
    ['army_moder', 'A cold wind falls from the mountains. Moder’s brood has not forgotten.'],
    ['army_goblin', 'The horde descends. Hold the wall — this is how sagas are made.'],
    ['army_seekers', 'They sought you out. The Mistlands do not forgive trespass.'],
    ['army_gjall', 'A Gjall drifts from the mist, heavy with menace. Look up.'],
    ['foresttrolls', 'The ground shakes — trolls come through the trees. Mind your roof.'],
    ['wolves', 'You are being hunted. The pack has your scent now.'],
    ['surtlings', 'Sulfur taints the air. The embers are rising.'],
    ['skeletons', 'The dead walk tonight. They remember little; I remember all.'],
    ['bats', 'You stirred the cauldron — wings gather in the dark.'],
  ] as const
).map(([id, line]) => ({
  id: `raid-${id}`,
  category: 'raid',
  label: 'Raids',
  pattern: `Random event set:${id}`,
  title: `⚔️ ${line}`,
}));

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
    // Cap the image's in-container world backups (/config/backups) at the same
    // count our S3 rotation keeps (BACKUPS_TO_KEEP=7). Default is 0 = unlimited,
    // which let them pile up inside the volume (a source of the backup bloat).
    // These are local rollback only — our backupExcludes keeps them out of the
    // off-box S3 archive. Valheim's own native *_backup_auto-* saves aren't env-
    // tunable (the image exposes no knob) and are self-capped by the game.
    staticEnv: { BACKUPS_MAX_COUNT: '7' },
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
    // Exclude all THREE local backup layers that pile up inside the volume — they're
    // cheap in-place rollback, not DR, and archiving them compounds our S3 tar every
    // session (observed: 390MB → 1.4GB in days, of which the live world is only ~82MB):
    //   ./backups            — the lloesche image's hourly world zips (/config/backups)
    //   *_backup_auto-*      — Valheim's OWN native auto-backups, kept beside the live save
    //   *.old                — Valheim's save-rotation copies (another full world each)
    backupExcludes: ['./backups', '*_backup_auto-*', '*.old'],
  },

  ports: [
    { protocol: 'udp', from: 2456, to: 2458 },
    { protocol: 'tcp', from: 2456, to: 2458 },
  ],
  queryPort: 2457,

  instanceType: 't3.medium',
  dataVolumeSizeGb: 12,
  autoShutdownMinutes: 15, // idle-stop after 15 min with no players (cost control)
  bootTimeoutMinutes: 45,  // generous: first boot SteamCMD-pulls the server image
  messageTtlHours: 16,     // session status message auto-deletes 16h after offline

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

  // Flavor posts, each gated by its own `/<cmd> notify` category (deaths, raids,
  // joins, leaves — toggle independently). Munin "remembers every death" — now he
  // actually does. Deaths carry the name (ZDOID 0:0 = death/unload, so an
  // occasional logoff reads as a death — on-brand for Munin); join/leave don't
  // (Valheim's join line names the server, not the player). Raids are detected by
  // the `Random event set:<id>` line and spoken in Munin's voice (the in-game
  // banner already shows, so this is colour, not information).
  events: [
    {
      id: 'death',
      category: 'death',
      label: 'Deaths',
      pattern: 'Got character ZDOID from .+ : 0:0',
      nameSed: 's/.*Got character ZDOID from (.+) : 0:0.*/\\1/',
      title: '☠️ {name} has fallen',
      body: 'Another name for the saga. I remember them all — the deaths most of all.',
    },
    ...valheimRaids,
    {
      id: 'join',
      category: 'join',
      label: 'Joins',
      // A player's NAME first appears at character spawn ("Got character ZDOID
      // from <name> : <id>"), which re-fires on every respawn — so dedup by name
      // to announce each viking once per session. (The death event matches the
      // same line family but keys per-line, so the two never cross-suppress.)
      pattern: 'Got character ZDOID from .+ :',
      nameSed: 's/.*Got character ZDOID from (.+) : .*/\\1/',
      dedupByName: true,
      title: '🛡️ {name} enters the hall',
    },
    {
      id: 'leave',
      category: 'leave',
      label: 'Leaves',
      // Valheim logs this on ANY dropped connection, not just a deliberate exit —
      // and disconnects are a known Valheim pain point (worse in later biomes),
      // so the raw line announced a departure every time someone blipped out and
      // walked straight back in. confirmDrop waits a cycle and checks the count.
      pattern: 'Player connection lost server .* now [0-9]+ player',
      confirmDrop: true,
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
    // MuninBot's Discord app icon — the webhook avatar, so host posts read as the
    // bot while the raven art (thumbnailUrl) shows inside the embed.
    iconUrl: 'https://cdn.discordapp.com/app-icons/1514149450019508224/182b0b7af0816c2602ce42754ad7e2dc.png',
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
