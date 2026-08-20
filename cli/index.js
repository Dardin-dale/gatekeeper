#!/usr/bin/env node
'use strict';
// GATEKeeper CLI — a small, game-aware companion to the Discord bot. Server
// control (start/stop/status) lives in Discord (/gate ...); this CLI covers the
// out-of-band bits: pulling saves down for safekeeping and triggering backups.
// Select the game with GAME=<id> (default abiotic-factor).

const backup = require('./commands/backup');
const world = require('./commands/world');
const mods = require('./commands/mods');
const discord = require('./commands/discord');
const worlds = require('./commands/worlds');
const config = require('./commands/config');
const { GAME_ID, STACK_NAME } = require('./lib/context');

function usage() {
  console.log(`GATEKeeper CLI  —  game: ${GAME_ID}  (stack: ${STACK_NAME})

Usage:
  npm run cli backup list                    List S3 backups for the active game
  npm run cli backup pull [name|latest]      Download a backup to ./local/backups/<game>
  npm run cli backup create                  Trigger a backup on the running server
  npm run cli backup restore [name|latest]   Restore a backup onto the running server

  npm run cli world add <name> --password=<pw> Add a world to config/<game>.worlds.json
                                             (--guild --world --default --admins --args --mods; local, deploy to apply)
  npm run cli world switch [name]            Set (or show) a guild's default world — what a bare /<cmd> start loads
                                             (--guild to pick the server, --dry to preview; live SSM, no restart)
  npm run cli world push <dir|tar.gz> [name] Upload a local save as a seed archive
                                             (bare names resolve in ./local/seeds/<game>)
  npm run cli world pull [name|latest]       Download a seed archive to ./local/seeds/<game>
  npm run cli world list                     List uploaded seed archives
  npm run cli world restore [name|latest]    Restore a seed archive onto the running server

  npm run cli mods list                      List the S3 mod library
  npm run cli mods add <file|dir|zip> [name] Add a downloaded mod (--kind k --url u --version v)
  npm run cli mods import <Ns/Mod[@ver]>     Import from Thunderstore (games with a community)
  npm run cli mods info <name>               Show a mod's metadata
  npm run cli mods remove <name>             Remove a mod from the library

  npm run cli worlds list                    Compare local worlds config against the deployed one
  npm run cli worlds pull                    Recover config/<game>.worlds.json from the deployed stack
  npm run cli discord put-token              Seed the bot token to SSM (presence sidecar)
  npm run cli discord invite-url             Print this game's install/permission URL

  npm run cli config show                     Show runtime tunables (idle/boot timers)
  npm run cli config set <key> <min|off>      Retune auto-shutdown | boot-timeout live
  npm run cli config reconstruct [--env]      Rebuild gitignored config/ (and .env) from the live deploy
                                             (--force overwrites; safe/read-only against AWS)

Notes:
  - Server start/stop/status are Discord commands: /gate start | stop | status
  - Choose a game with GAME=<id> (e.g. GAME=valheim npm run cli backup list)
  - World bootstrap layout + walkthrough: docs/cli.md`);
}

async function main() {
  const [group, sub, ...rest] = process.argv.slice(2);

  if (group === 'backup') {
    if (sub === 'list') return backup.list();
    if (sub === 'pull') return backup.pull(rest[0]);
    if (sub === 'create') return backup.create();
    if (sub === 'restore') return world.restore(rest[0], 'backups');
  }

  if (group === 'world') {
    if (sub === 'add') return world.add(...rest);
    if (sub === 'switch') return world.switchDefault(...rest);
    if (sub === 'push') return world.push(rest[0], rest[1]);
    if (sub === 'pull') return world.pull(rest[0]);
    if (sub === 'list') return world.list();
    if (sub === 'restore') return world.restore(rest[0], 'bootstrap');
  }

  if (group === 'mods') {
    if (sub === 'list') return mods.list();
    if (sub === 'add') return mods.add(...rest);
    if (sub === 'import') return mods.importMod(...rest);
    if (sub === 'info') return mods.info(rest[0]);
    if (sub === 'remove') return mods.remove(rest[0]);
  }

  if (group === 'worlds') {
    if (sub === 'list') return worlds.list();
    if (sub === 'pull') return worlds.pull();
  }

  if (group === 'discord') {
    if (sub === 'put-token') return discord.putToken();
    if (sub === 'invite-url') return discord.inviteUrl();
  }

  if (group === 'config') {
    if (sub === 'show' || sub === 'list') return config.show();
    if (sub === 'set') return config.set(rest[0], rest[1]);
    if (sub === 'reconstruct' || sub === 'pull') return config.reconstruct(...rest);
  }

  usage();
  if (group) process.exitCode = 1; // unknown command
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
