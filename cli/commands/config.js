'use strict';
// Runtime tunables the monitor reads from SSM each cycle: the idle auto-shutdown
// window and the boot-timeout safety net. The stack seeds these at deploy from
// the GameProfile (AUTO_SHUTDOWN_MINUTES / BOOT_TIMEOUT_MINUTES override), but
// they're plain SSM Strings — so this command retunes them live, no redeploy.
// The monitor re-reads the param on its next cycle, so a change takes effect
// within ~one cycle without restarting the server.

const { SSMClient, GetParameterCommand, PutParameterCommand } = require('@aws-sdk/client-ssm');
const { GAME_ID, REGION } = require('../lib/context');

// CLI key -> { param suffix, deploy-default } for the tunables we expose.
const KNOBS = {
  'auto-shutdown': { param: 'auto-shutdown-minutes', def: '15', label: 'Idle auto-shutdown' },
  'boot-timeout': { param: 'boot-timeout-minutes', def: '45', label: 'Boot-timeout' },
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

// Accept a positive integer (minutes) or the disable sentinels.
function normalizeValue(raw) {
  const v = String(raw).trim().toLowerCase();
  if (v === 'off' || v === 'disabled') return v;
  if (/^\d+$/.test(v) && Number(v) > 0) return v;
  throw new Error(`Invalid value "${raw}" — expected a positive number of minutes, or "off".`);
}

async function show() {
  const ssm = new SSMClient({ region: REGION });
  console.log(`Runtime config for ${GAME_ID}:`);
  for (const [key, { param, def, label }] of Object.entries(KNOBS)) {
    const val = await getParam(ssm, param);
    const shown = val === undefined ? `${def} (default — param unset)` : val;
    const human = val === 'off' || val === 'disabled' ? ' → disabled' : (/^\d+$/.test(val || def) ? ' min' : '');
    console.log(`  ${key.padEnd(14)} ${label.padEnd(20)} ${shown}${val === undefined ? '' : human}`);
  }
  console.log(`\nChange with: npm run cli config set <auto-shutdown|boot-timeout> <minutes|off>`);
}

async function set(key, value) {
  const knob = KNOBS[key];
  if (!knob) {
    throw new Error(`Unknown key "${key}". Valid keys: ${Object.keys(KNOBS).join(', ')}.`);
  }
  if (value === undefined) {
    throw new Error(`Missing value. Usage: npm run cli config set ${key} <minutes|off>`);
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
  const effect = normalized === 'off' || normalized === 'disabled' ? 'disabled' : `${normalized} min`;
  console.log(`Set ${name} = ${normalized} (${knob.label.toLowerCase()} → ${effect}).`);
  console.log('The on-host monitor re-reads SSM each cycle, so it takes effect within ~one cycle.');
}

module.exports = { show, set };
