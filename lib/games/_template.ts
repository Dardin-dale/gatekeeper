import { GameProfile } from './types';

/**
 * SCAFFOLD — copy this file to lib/games/<your-game>.ts to add a new game.
 *
 * Adding a game is fill-in-the-blanks:
 *   1. Copy this file, replace every TODO, export as a named const.
 *   2. Register it in lib/games/index.ts (add to GAME_PROFILES).
 *   3. Create config/<id>.worlds.example.json from the AF example.
 *   4. Deploy with GAME=<id>  ->  GateStack-<Id> (own isolated stack).
 *
 * See docs/adding-a-game.md for the full checklist. This template is NOT
 * registered and is never deployed.
 */
export const templateGame: GameProfile = {
  id: 'TODO-game-id', // kebab-case; drives stack name + SSM subtree + config filename
  displayName: 'TODO Game Name',
  commandName: 'TODO', // top-level Discord command, e.g. 'gate' -> /gate start

  container: {
    image: 'TODO/image:tag',
    name: 'TODO-server',
    staticEnv: {
      // Env vars always set, e.g. { AutoUpdate: 'true' }
    },
    envMap: {
      // Map canonical fields -> this game's container env var names.
      password: 'TODO_PASSWORD_ENV',
      // serverName: 'TODO',
      // worldName: 'TODO',
      // adminIds: 'TODO',
      // extraArgs: 'TODO',
    },
    volumes: [{ hostPath: '/mnt/game-data/data', containerPath: '/data' }],
    savePath: 'TODO/relative/save/path',
  },

  ports: [{ protocol: 'udp', from: 0, to: 0 }], // TODO real game ports
  queryPort: 27015, // Steam A2S query port — required (monitoring polls it)

  instanceType: 't3.medium', // TODO size for the game
  dataVolumeSizeGb: 12,
  autoShutdownMinutes: 15, // idle-stop after N min with no players (cost control); 'off' to disable
  bootTimeoutMinutes: 45,  // stop a wedged boot after N min so it can't bill forever; 'off' to disable
  messageTtlHours: 16,     // auto-delete a session's status message N hours after it goes offline; 'off' to keep

  // address (IP:port) for most games, or { type: 'join-code', logPattern } for crossplay codes.
  join: { type: 'address', port: 0 }, // TODO real join port

  // OPTIONAL — delete if the game has no mod story. Each kind maps a library
  // mod's metadata `kind` to the host dir its files install into (must live on
  // the persistent volume mounts above). See docs/mods.md.
  // mods: {
  //   kinds: { 'TODO-kind': { targetPath: '/mnt/game-data/data/TODO', env: {} } },
  //   source: { type: 'manual', portalUrl: 'TODO mod portal URL' },
  //   clientsMustMatch: true, // players must mirror the server's mods to join
  // },

  persona: {
    botName: 'GATEKeeper',
    characterName: 'TODO Character',
    color: 0xffffff,
    footer: 'TODO',
    hailQuotes: ['TODO first-person ping line'],
  },
};
