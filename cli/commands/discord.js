'use strict';
// Discord credential plumbing the stack can't do itself: CloudFormation cannot
// create SecureString parameters, so the presence sidecar's bot token is seeded
// into SSM once, out-of-band, from the gitignored config/<game>.discord.json.

const fs = require('fs');
const path = require('path');
const { SSMClient, PutParameterCommand } = require('@aws-sdk/client-ssm');
const { GAME_ID, REGION } = require('../lib/context');

// Seed /gatekeeper/<game>/discord-bot-token (SecureString) for presence.js.
// Same credential resolution as the stack/register-commands: prefer the
// per-game config/<game>.discord.json, fall back to .env.
async function putToken() {
  const cfgPath = path.join(__dirname, '../../config', `${GAME_ID}.discord.json`);
  let botToken;
  if (fs.existsSync(cfgPath)) {
    botToken = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).botToken;
  } else {
    try { process.loadEnvFile(); } catch (e) { /* no .env */ }
    botToken = process.env.DISCORD_BOT_SECRET_TOKEN;
  }
  if (!botToken || /FILL-ME|your-/.test(botToken)) {
    throw new Error(`No bot token for ${GAME_ID}: fill config/${GAME_ID}.discord.json or .env (DISCORD_BOT_SECRET_TOKEN).`);
  }
  const name = `/gatekeeper/${GAME_ID}/discord-bot-token`;
  const ssm = new SSMClient({ region: REGION });
  await ssm.send(new PutParameterCommand({
    Name: name,
    Value: botToken,
    Type: 'SecureString',
    Overwrite: true,
  }));
  console.log(`Seeded ${name} (SecureString).`);
  console.log('The presence sidecar picks it up on its next (re)start:');
  console.log('  game-presence.service on the instance — bot shows online while the server runs.');
}

// Invite / re-invite URL. Discord has no way for a bot to request permissions
// after install — re-running authorization with a larger integer is the only
// route (docs/discord-setup.md). The integer is derived from named flags so the
// grant is auditable, and the app id is read per-game rather than baked in.
const PERMISSION_FLAGS = {
  VIEW_CHANNEL: 1n << 10n,          // see the channel at all
  SEND_MESSAGES: 1n << 11n,         // fallback posts; persona posts go via webhook
  MANAGE_MESSAGES: 1n << 13n,       // PIN the durable status message
  EMBED_LINKS: 1n << 14n,           // rich embeds
  READ_MESSAGE_HISTORY: 1n << 16n,  // required alongside MANAGE_MESSAGES to pin
  MANAGE_WEBHOOKS: 1n << 29n,       // `/<cmd> setup` creates the channel webhook
};

function permissionsInteger(names = Object.keys(PERMISSION_FLAGS)) {
  return names.reduce((acc, n) => acc | PERMISSION_FLAGS[n], 0n);
}

/** This game's Discord application id (config/<game>.discord.json, else .env). */
function resolveAppId() {
  const cfgPath = path.join(__dirname, '../../config', `${GAME_ID}.discord.json`);
  let appId;
  if (fs.existsSync(cfgPath)) {
    appId = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).appId;
  }
  if (!appId) {
    try { process.loadEnvFile(); } catch (e) { /* no .env */ }
    appId = process.env.DISCORD_APP_ID;
  }
  if (!appId || /FILL-ME|your-/.test(String(appId))) {
    throw new Error(`No Discord app id for ${GAME_ID}: fill config/${GAME_ID}.discord.json (appId) or .env (DISCORD_APP_ID).`);
  }
  return String(appId);
}

/**
 * Print the OAuth2 install URL for this game's app. Use it for the first install
 * AND to widen permissions later — same link, same flow.
 */
function inviteUrl() {
  const appId = resolveAppId();
  const perms = permissionsInteger();
  const url = `https://discord.com/oauth2/authorize?client_id=${appId}`
    + `&scope=bot+applications.commands&permissions=${perms}`;

  console.log(`Invite URL for ${GAME_ID} (app ${appId}):\n`);
  console.log(`  ${url}\n`);
  console.log(`Permissions (${perms}):`);
  for (const [name, bit] of Object.entries(PERMISSION_FLAGS)) {
    console.log(`  ${name.padEnd(22)} 1 << ${String(BigInt(bit).toString(2).length - 1).padStart(2)}  = ${bit}`);
  }
  console.log(`
Open it, pick the server, Authorize. Already added? Re-running the same link is
how you GRANT NEW PERMISSIONS — Discord has no "request more permissions" flow.
It will not kick the bot, change its token, or re-register commands.

NOTE: channel permission overwrites take precedence over server-level role
permissions. If a channel explicitly denies Manage Messages (directly or via
@everyone), this link cannot override it — fix that channel's overwrite.`);
}

module.exports = { putToken, inviteUrl, permissionsInteger, PERMISSION_FLAGS };
