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

module.exports = { putToken };
