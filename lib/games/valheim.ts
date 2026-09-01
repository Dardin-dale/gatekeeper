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
    // SERVER_PUBLIC is the image default, pinned on purpose: Steam's game-server
    // SDK only answers A2S (the monitor's liveness/player-count source for
    // vanilla worlds) while the server advertises itself. Verified locally:
    // with `-public 0` the 2457 query socket is bound but never read, so the
    // monitor would see a live server as booting forever. "Public" only means
    // listed in the community browser — the password still gates joins.
    staticEnv: { BACKUPS_MAX_COUNT: '7', SERVER_PUBLIC: 'true' },
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

  // Pre-live stages, patterns verbatim from a real boot (2026-08-20). The
  // container multiplexes supervisord services, so one log carries the updater
  // (SteamCMD + BepInEx) and the server itself — and they overlap: the server can
  // be connecting to PlayFab while the updater is still verifying. Phases are
  // ordered so the closest-to-joinable stage wins that tie.
  // ⚠️ The failure entry is not hypothetical: SteamCMD self-updated, restarted
  // mid-command, lost its install dir, and the updater died with "Missing
  // configuration" — the server never launched and the boot sat silent for 13
  // minutes with nothing in Discord to show for it.
  bootPhases: [
    {
      id: 'backup',
      pattern: 'valheim-backup INFO - Creating backup|adding: config/worlds_local',
      label: 'Backing up worlds',
      emoji: '\u{1F4BE}',
    },
    {
      id: 'steamcmd',
      // SteamCMD's own bootstrap. Its counter is thousands-separated here
      // ("36,155 of 40,321 KB"), unlike the plain digits Abiotic Factor logs.
      pattern: 'Downloading update \\([0-9,]+ of [0-9,]+ KB\\)',
      label: 'Updating SteamCMD',
      emoji: '\u{1F4E6}',
    },
    {
      id: 'downloading',
      pattern: 'Update state \\(0x[0-9a-f]+\\) downloading',
      progressPattern: 'progress: ([0-9]+\\.[0-9]+)',
      label: 'Downloading server files',
      emoji: '\u{2B07}',
    },
    {
      id: 'verifying',
      pattern: 'Update state \\(0x[0-9a-f]+\\) verifying',
      progressPattern: 'progress: ([0-9]+\\.[0-9]+)',
      label: 'Verifying server files',
      emoji: '\u{1F50D}',
    },
    {
      id: 'mods',
      pattern: 'BepInEx is enabled - running updater',
      label: 'Installing mods (BepInEx)',
      emoji: '\u{1F9E9}',
    },
    {
      id: 'loading',
      // "Game server connected" is the Steam logon and fires in BOTH modes;
      // "Opened PlayFab server" is crossplay-only. World generation (a fresh
      // world takes ~1 min) happens inside this phase.
      pattern: 'Opened PlayFab server|Game server connected',
      label: 'Loading the world',
      emoji: '\u{1F30D}',
    },
    {
      id: 'registering',
      // Crossplay registers with PlayFab; the join code lands moments later, and
      // liveness comes from the "is active with N player(s)" heartbeat. A vanilla
      // world instead logs "Registering lobby" / "Opened Steam server" (verbatim
      // from a local vanilla boot, 2026-09-01) and answers A2S seconds later.
      pattern: 'Register PlayFab server|registered with join code|Registering lobby|Opened Steam server',
      label: 'Registering session',
      emoji: '\u{1F4E1}',
    },
    {
      id: 'update-failed',
      // Both verbatim from the 2026-08-20 wedge. "Missing configuration" is
      // SteamCMD losing force_install_dir across its own self-update restart.
      pattern: 'ERROR! Failed to install app|Failed to download Valheim server from Steam',
      label: 'Server update FAILED \u2014 the server never launched',
      emoji: '\u{26A0}',
      failure: true,
    },
  ],

  // t3.large (8 GB) = upstream's RECOMMENDED spec. Was t3.medium, whose 4 GB
  // nominal presents as ~3.75 GiB usable — under upstream's own 4 GB MINIMUM, and
  // the container said so on every boot ("3.75 GiB is not enough memory"). Valheim's
  // footprint has also grown per biome update (Ashlands-era servers are commonly
  // cited around 6 GB), and modded worlds (BepInEx) or `-modifier resources more`
  // raise entity counts further. Roughly +$0.04/hr, only while a session is up.
  instanceType: 't3.large',
  dataVolumeSizeGb: 12,
  autoShutdownMinutes: 15, // idle-stop after 15 min with no players (cost control)
  bootTimeoutMinutes: 45,  // generous: first boot SteamCMD-pulls the server image
  messageTtlHours: 16,     // session status message auto-deletes 16h after offline

  // A vanilla (Steam-networking) world answers A2S on 2457, so the monitor's
  // primary path applies and neither pattern below is consulted.
  // ⚠️ With -crossplay (a per-world opt-in via `extraArgs`) Valheim switches to
  // PlayFab networking and does NOT answer A2S on 2457 — verified live on the
  // first GateStack-Valheim boot. Liveness + player count come from the log
  // instead, and they need DIFFERENT lines (the source of a real idle-shutdown
  // bug that kicked a mid-session player):
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

  // Two ways in, by port: the in-game "Join IP" box takes the GAME port
  // (<host>:2456, the Address field below); Steam's server browser (View → Game
  // Servers → Favorites) takes the QUERY port (<host>:2457) and remembers the
  // password after the first join — the derived domain keeps that favorite
  // stable. A join code exists ONLY for worlds started with `-crossplay`
  // (PlayFab); a vanilla world mints none, so the scraper finds nothing and the
  // Join Code field is simply omitted — the hint must read well either way.
  join: {
    type: 'join-code',
    // The scraper takes the last token of the latest MATCH (grep -oE), so the
    // pattern must include the digits: "... registered with join code 487341".
    logPattern: 'join code [0-9]+',
    codeLabel: 'Join Code', // Valheim's crossplay UI wording
    addressWithPort: true,  // Valheim's add-server box takes one "host:port" string
    hint: 'In-game: Join Game → Join IP with the address below. Or save it in Steam ' +
      '(View → Game Servers → Favorites) using port 2457 instead — Steam remembers the ' +
      'password after the first join. Crossplay worlds also get a join code.',
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
