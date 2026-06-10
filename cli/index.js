#!/usr/bin/env node
'use strict';
// GATEKeeper CLI — a small, game-aware companion to the Discord bot. Server
// control (start/stop/status) lives in Discord (/gate ...); this CLI covers the
// out-of-band bits: pulling saves down for safekeeping and triggering backups.
// Select the game with GAME=<id> (default abiotic-factor).

const backup = require('./commands/backup');
const world = require('./commands/world');
const mods = require('./commands/mods');
const { GAME_ID, STACK_NAME } = require('./lib/context');

function usage() {
  console.log(`GATEKeeper CLI  —  game: ${GAME_ID}  (stack: ${STACK_NAME})

Usage:
  npm run cli backup list                    List S3 backups for the active game
  npm run cli backup pull [name|latest]      Download a backup to ./local/backups
  npm run cli backup create                  Trigger a backup on the running server
  npm run cli backup restore [name|latest]   Restore a backup onto the running server

  npm run cli world push <dir|tar.gz> [name] Upload a local save as a seed archive
  npm run cli world list                     List uploaded seed archives
  npm run cli world restore [name|latest]    Restore a seed archive onto the running server

  npm run cli mods list                      List the S3 mod library
  npm run cli mods add <file|dir|zip> [name] Add a downloaded mod (--kind k --url u --version v)
  npm run cli mods import <Ns/Mod[@ver]>     Import from Thunderstore (games with a community)
  npm run cli mods info <name>               Show a mod's metadata
  npm run cli mods remove <name>             Remove a mod from the library

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
    if (sub === 'push') return world.push(rest[0], rest[1]);
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

  usage();
  if (group) process.exitCode = 1; // unknown command
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
