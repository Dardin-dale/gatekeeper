'use strict';
// Discord credential plumbing the stack can't do itself: CloudFormation cannot
// create SecureString parameters, so the presence sidecar's bot token is seeded
// into SSM once, out-of-band, from the gitignored config/<game>.discord.json.

const fs = require('fs');
const path = require('path');
const { SSMClient, PutParameterCommand } = require('@aws-sdk/client-ssm');
const { GAME_ID, REGION } = require('../lib/context');

// Seed /gatekeeper/<game>/discord-bot-token (SecureString) for presence.js.
async function putToken() {
  const cfgPath = path.join(__dirname, '../../config', `${GAME_ID}.discord.json`);
  if (!fs.existsSync(cfgPath)) {
    throw new Error(`No config/${GAME_ID}.discord.json — create it from the example first.`);
  }
  const { botToken } = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  if (!botToken || /FILL-ME|your-/.test(botToken)) {
    throw new Error(`config/${GAME_ID}.discord.json has no real botToken yet.`);
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
