import { GameProfile } from './types';

/**
 * Valheim — faithful profile STUB proving the GameProfile contract covers the
 * original huginbot game. NOT deployed by GATEKeeper in this pass; it documents
 * the second data point (log-scrape player count + join-code) so the abstraction
 * isn't shaped by a single game. Porting/retiring huginbot onto this is a later pass.
 */
export const valheim: GameProfile = {
  id: 'valheim',
  displayName: 'Valheim',
  commandName: 'hugin', // /hugin start | stop | status | hail | join | setup | help
  subdomain: 'valheim', // valheim.<BASE_DOMAIN>

  container: {
    image: 'ghcr.io/community-valheim-tools/valheim-server',
    name: 'valheim-server',
    staticEnv: {},
    envMap: {
      serverName: 'SERVER_NAME',
      worldName: 'WORLD_NAME',
      password: 'SERVER_PASS',
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

  // Valheim answers A2S on its query port (2457) like any Steam server, so the
  // generic poller monitors it; only its crossplay join CODE is the carve-out.
  join: { type: 'join-code', logPattern: '(with|has|that has) join code' },

  persona: {
    botName: 'HuginBot',
    characterName: 'Hugin',
    color: 0x2c2f33,
    thumbnailUrl: 'https://static.wikia.nocookie.net/valheim/images/7/7d/Hugin.png',
    footer: 'Wisdom of the All-Father',
    hailQuotes: [
      'Hrafn! The All-Father sent me to guide you.',
      'Skål! Your halls await worthy warriors!',
      'The server stands ready, will you answer the call?',
      'The ravens watch over your world. Odin is pleased.',
      'Hugin remembers all backups in Odin\'s wisdom.',
      'I spy with my raven eye, players venturing forth!',
    ],
  },
};
