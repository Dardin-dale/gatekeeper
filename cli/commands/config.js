'use strict';
// Runtime tunables the monitor reads from SSM each cycle: the idle auto-shutdown
// window and the boot-timeout safety net. The stack seeds these at deploy from
// the GameProfile (AUTO_SHUTDOWN_MINUTES / BOOT_TIMEOUT_MINUTES override), but
// they're plain SSM Strings — so this command retunes them live, no redeploy.
// The monitor re-reads the param on its next cycle, so a change takes effect
// within ~one cycle without restarting the server.

const fs = require('fs');
const path = require('path');
const { SSMClient, GetParameterCommand, PutParameterCommand } = require('@aws-sdk/client-ssm');
const { CloudFormationClient, GetTemplateCommand } = require('@aws-sdk/client-cloudformation');
const { GAME_ID, REGION, STACK_NAME } = require('../lib/context');
const { parseFlags } = require('../lib/args');
const R = require('../lib/reconstruct');

const CONFIG_DIR = process.env.GATEKEEPER_CONFIG_DIR || path.join(process.cwd(), 'config');

// CLI key -> { param suffix, deploy-default, unit } for the tunables we expose.
const KNOBS = {
  'auto-shutdown': { param: 'auto-shutdown-minutes', def: '15', label: 'Idle auto-shutdown', unit: 'min' },
  'boot-timeout': { param: 'boot-timeout-minutes', def: '45', label: 'Boot-timeout', unit: 'min' },
  'message-ttl': { param: 'message-ttl-hours', def: '16', label: 'Status message TTL', unit: 'h' },
  'extend': { param: 'extend-minutes', def: '5', label: 'Idle extend window', unit: 'min' },
};

function paramName(suffix) {
  return `/gatekeeper/${GAME_ID}/${suffix}`;
}

async function getParam(ssm, suffix) {
  try {
    const r = await ssm.send(new GetParameterCommand({ Name: paramName(suffix) }));
    return r.Parameter && r.Parameter.Value;
  } catch (err) {
    if (err.name === 'ParameterNotFound') return undefined;
    throw err;
  }
}

// Accept a positive integer (minutes/hours, per the knob) or the disable sentinels.
function normalizeValue(raw) {
  const v = String(raw).trim().toLowerCase();
  if (v === 'off' || v === 'disabled') return v;
  if (/^\d+$/.test(v) && Number(v) > 0) return v;
  throw new Error(`Invalid value "${raw}" — expected a positive whole number, or "off".`);
}

async function show() {
  const ssm = new SSMClient({ region: REGION });
  console.log(`Runtime config for ${GAME_ID}:`);
  for (const [key, { param, def, label, unit }] of Object.entries(KNOBS)) {
    const val = await getParam(ssm, param);
    const shown = val === undefined ? `${def} (default — param unset)` : val;
    const human = val === 'off' || val === 'disabled' ? ' → disabled' : (/^\d+$/.test(val || def) ? ` ${unit}` : '');
    console.log(`  ${key.padEnd(14)} ${label.padEnd(22)} ${shown}${val === undefined ? '' : human}`);
  }
  console.log(`\nChange with: npm run cli config set <auto-shutdown|boot-timeout|message-ttl> <number|off>`);
}

async function set(key, value) {
  const knob = KNOBS[key];
  if (!knob) {
    throw new Error(`Unknown key "${key}". Valid keys: ${Object.keys(KNOBS).join(', ')}.`);
  }
  if (value === undefined) {
    throw new Error(`Missing value. Usage: npm run cli config set ${key} <number|off>`);
  }
  const normalized = normalizeValue(value);
  const ssm = new SSMClient({ region: REGION });
  const name = paramName(knob.param);
  await ssm.send(new PutParameterCommand({
    Name: name,
    Value: normalized,
    Type: 'String',
    Overwrite: true,
  }));
  const effect = normalized === 'off' || normalized === 'disabled' ? 'disabled' : `${normalized} ${knob.unit}`;
  console.log(`Set ${name} = ${normalized} (${knob.label.toLowerCase()} → ${effect}).`);
  console.log('Read live: the host re-reads timers each monitor cycle; message-ttl applies to the next session.');
}

// --- config reconstruct ------------------------------------------------------
// Rebuild the gitignored config for the active game from the DEPLOYED
// CloudFormation template — the recovery path for a fresh machine that never got
// a copy of config/. Read-only against AWS (one GetTemplate); writes local files
// only. Skips files that already exist unless --force, so it can't clobber local
// edits. See docs/cli.md and the config-reconstruction source-map.

function writeUnlessExists(dest, contents, force) {
  if (contents == null) return; // nothing to write for this file
  if (fs.existsSync(dest) && !force) {
    console.log(`  skip   ${dest} (exists — pass --force to overwrite)`);
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, contents);
  console.log(`  wrote  ${dest}`);
}

async function reconstruct(...rest) {
  const { flags } = parseFlags(rest);
  const force = !!flags.force;
  const withEnv = !!flags.env;

  console.log(`Reconstructing ${GAME_ID} config from the deployed ${STACK_NAME} template ...`);
  const cf = new CloudFormationClient({ region: REGION });
  let res;
  try {
    res = await cf.send(new GetTemplateCommand({ StackName: STACK_NAME }));
  } catch (err) {
    throw new Error(
      `Could not read ${STACK_NAME} in ${REGION}. Is it deployed and is GAME/AWS_REGION set? (${err.message})`
    );
  }
  let tpl = res.TemplateBody;
  if (typeof tpl === 'string') {
    try {
      tpl = JSON.parse(tpl);
    } catch (e) {
      throw new Error(`${STACK_NAME}'s template isn't JSON, so it can't be reconstructed automatically.`);
    }
  }

  const env = R.lambdaEnvFromTemplate(tpl);
  if (!Object.keys(env).length) {
    throw new Error(`No Lambda env vars found in ${STACK_NAME} — nothing to reconstruct.`);
  }

  // 1) config/<game>.worlds.json
  const worlds = env.WORLDS_JSON ? R.prettyWorldsJson(env.WORLDS_JSON) : null;
  if (env.WORLDS_JSON && worlds == null) console.log('  (WORLDS_JSON present but unparseable — skipping worlds.json)');
  if (!env.WORLDS_JSON) console.log('  (no WORLDS_JSON in the template — skipping worlds.json)');
  writeUnlessExists(path.join(CONFIG_DIR, `${GAME_ID}.worlds.json`), worlds, force);

  // 2) config/<game>.discord.json
  const discord = R.discordJson(env);
  if (!discord) console.log('  (no Discord creds in the template — skipping discord.json)');
  writeUnlessExists(path.join(CONFIG_DIR, `${GAME_ID}.discord.json`), discord, force);

  // 3) .env (opt-in — it's the shared/global file, not per-game)
  if (withEnv) {
    const envContents = R.envFile(env, {
      region: REGION,
      email: R.billingEmailFromTemplate(tpl),
      backupsToKeep: R.backupsToKeepFromTemplate(tpl),
      gameId: GAME_ID,
    });
    writeUnlessExists(path.join(process.cwd(), '.env'), envContents, force);
  } else {
    console.log('  (.env not written — pass --env to also rebuild the shared .env)');
  }

  console.log('Done. These are LOCAL, gitignored files — nothing was deployed.');
}

module.exports = { show, set, reconstruct };
