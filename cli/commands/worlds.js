'use strict';
// Recover config/<game>.worlds.json from the deployed stack.
//
// That file is gitignored (it holds per-world passwords), so it is unversioned
// and machine-local: edit it on one machine and the next deploy from another
// SILENTLY narrows the deployed world list, because the stack reads the file into
// WORLDS_JSON at synth. That happened — two Valheim worlds added on a laptop were
// one deploy away from vanishing from the bot. The deployed Lambda env is the
// authoritative copy (SSM only holds the single active world), so pull from there.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { CloudFormationClient, DescribeStackResourcesCommand } = require('@aws-sdk/client-cloudformation');
const { GAME_ID, REGION, STACK_NAME } = require('../lib/context');

const configPath = () => path.join(__dirname, '../../config', `${GAME_ID}.worlds.json`);

/**
 * WORLDS_JSON as deployed, from the LIVE Lambda configuration.
 *
 * Two roads not taken. GetTemplate (CloudFormation is already a dependency)
 * returns non-ASCII mangled — a world named 'Emmumóðir' comes back 'Emmum??ir',
 * and pulling that would corrupt the name on the next deploy. @aws-sdk/client-lambda
 * reads it correctly but drags in a conflicting @smithy/types that breaks `tsc`
 * across the other SDK clients. So: shell out to the AWS CLI, as the host scripts
 * already do, and parse its JSON.
 */
async function deployedWorldsJson() {
  const cfn = new CloudFormationClient({ region: REGION });
  const { StackResources } = await cfn.send(new DescribeStackResourcesCommand({ StackName: STACK_NAME }));
  const fn = (StackResources || []).find(
    (r) => r.ResourceType === 'AWS::Lambda::Function' && r.LogicalResourceId.startsWith('CommandsFunction'),
  );
  if (!fn) throw new Error(`No CommandsFunction found in ${STACK_NAME} — is the stack deployed?`);
  const out = execFileSync('aws', [
    'lambda', 'get-function-configuration',
    '--region', REGION,
    '--function-name', fn.PhysicalResourceId,
    '--output', 'json',
  ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const raw = JSON.parse(out).Environment?.Variables?.WORLDS_JSON;
  if (!raw) throw new Error(`${fn.PhysicalResourceId} has no WORLDS_JSON — nothing to recover.`);
  return raw;
}

/** Names + shape only; never prints passwords. */
function summarize(worlds, label) {
  console.log(`${label} (${worlds.length}):`);
  for (const w of worlds) {
    const flags = [w.default ? 'default' : null, w.mods?.length ? `${w.mods.length} mod(s)` : null]
      .filter(Boolean).join(', ');
    console.log(`  - ${w.name}  (world: ${w.worldName})${flags ? `  [${flags}]` : ''}`);
  }
}

async function list() {
  const deployed = JSON.parse(await deployedWorldsJson());
  summarize(deployed, `Deployed worlds for ${GAME_ID}`);
  const p = configPath();
  if (!fs.existsSync(p)) return console.log(`\nLocal ${path.relative(process.cwd(), p)}: MISSING`);
  const local = JSON.parse(fs.readFileSync(p, 'utf8'));
  console.log('');
  summarize(local, 'Local config');
  const onlyDeployed = deployed.filter((d) => !local.some((l) => l.name === d.name)).map((w) => w.name);
  const onlyLocal = local.filter((l) => !deployed.some((d) => d.name === l.name)).map((w) => w.name);
  if (!onlyDeployed.length && !onlyLocal.length) return console.log('\n✅ In sync.');
  // Deploying with worlds missing locally is the destructive direction: it
  // rewrites WORLDS_JSON and drops them from the bot (saves on EBS are untouched).
  if (onlyDeployed.length) console.log(`\n⚠️  Deployed but NOT local: ${onlyDeployed.join(', ')} — a deploy would REMOVE these. Run 'worlds pull'.`);
  if (onlyLocal.length) console.log(`\nLocal but not yet deployed: ${onlyLocal.join(', ')} — a deploy would add these.`);
}

async function pull() {
  const raw = await deployedWorldsJson();
  const worlds = JSON.parse(raw); // fail before touching the file if it's malformed
  const p = configPath();
  if (fs.existsSync(p)) {
    const backup = `${p}.bak`;
    fs.copyFileSync(p, backup);
    console.log(`Backed up existing config to ${path.basename(backup)}`);
  }
  fs.writeFileSync(p, raw.endsWith('\n') ? raw : `${raw}\n`, 'utf8');
  summarize(worlds, `Wrote ${path.relative(process.cwd(), p)}`);
  console.log('\nWritten verbatim from the deployed env, so a redeploy is a no-op for WORLDS_JSON.');
}

module.exports = { list, pull };
