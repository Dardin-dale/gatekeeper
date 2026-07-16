'use strict';
// Pure helpers for `config reconstruct`: pull the gitignored config back out of a
// deployed CloudFormation template. CDK bakes the config into the template as
// literal Lambda env vars (WORLDS_JSON, Discord creds, BASE_DOMAIN, …) plus the
// budget email on the AWS::Budgets::Budget resource — so the whole gitignored
// surface is recoverable from one GetTemplate call, no per-value AWS lookups.
// Kept IO-free so they're unit-testable against a fixture template.

// The commands Lambda's *string* env vars are the source of truth for the config.
// Intrinsics (Ref/Fn::Join for e.g. SERVER_INSTANCE_ID) are dropped — we only
// want the literals a human would have put in .env / config files.
function lambdaEnvFromTemplate(tpl) {
  const resources = (tpl && tpl.Resources) || {};
  const lambdas = Object.entries(resources).filter(([, r]) => r.Type === 'AWS::Lambda::Function');
  const varsOf = (r) => (((r.Properties || {}).Environment || {}).Variables) || {};
  const pick =
    lambdas.find(([id]) => /Commands/i.test(id)) ||
    lambdas.find(([, r]) => varsOf(r).WORLDS_JSON);
  const vars = pick ? varsOf(pick[1]) : {};
  const env = {};
  for (const [k, v] of Object.entries(vars)) if (typeof v === 'string') env[k] = v;
  return env;
}

// BILLING_ALERT_EMAIL lives on the budget's email subscriber.
function billingEmailFromTemplate(tpl) {
  const resources = (tpl && tpl.Resources) || {};
  for (const r of Object.values(resources)) {
    if (r.Type !== 'AWS::Budgets::Budget') continue;
    for (const n of ((r.Properties || {}).NotificationsWithSubscribers || [])) {
      for (const s of (n.Subscribers || [])) {
        if (s.SubscriptionType === 'EMAIL' && typeof s.Address === 'string') return s.Address;
      }
    }
  }
  return undefined;
}

// The cleanup Lambda carries BACKUPS_TO_KEEP; fall back to the code default (7).
function backupsToKeepFromTemplate(tpl) {
  const resources = (tpl && tpl.Resources) || {};
  for (const r of Object.values(resources)) {
    if (r.Type !== 'AWS::Lambda::Function') continue;
    const v = (((r.Properties || {}).Environment || {}).Variables || {}).BACKUPS_TO_KEEP;
    if (typeof v === 'string') return v;
  }
  return undefined;
}

// appId = base64(the bot token's first '.'-segment).
function appIdFromToken(token) {
  if (!token) return '';
  try {
    return Buffer.from(String(token).split('.')[0], 'base64').toString('utf8');
  } catch (e) {
    return '';
  }
}

// Pretty worlds.json (2-space + trailing newline), matching how the file is
// hand-authored. Returns null if WORLDS_JSON doesn't parse.
function prettyWorldsJson(worldsJson) {
  try {
    return JSON.stringify(JSON.parse(worldsJson), null, 2) + '\n';
  } catch (e) {
    return null;
  }
}

// { appId, publicKey, botToken } — the per-game discord.json. Null if neither
// the public key nor token is present.
function discordJson(env) {
  const publicKey = env.DISCORD_BOT_PUBLIC_KEY || '';
  const botToken = env.DISCORD_BOT_TOKEN || '';
  if (!publicKey && !botToken) return null;
  return JSON.stringify({ appId: appIdFromToken(botToken), publicKey, botToken }, null, 2) + '\n';
}

// The shared/global .env. Discord creds are intentionally omitted (per-game
// discord.json owns them). Deploy-time knobs that equal GameProfile defaults
// (instance type, timers) are omitted too — the profile is the source of truth.
function envFile(env, opts) {
  const { region, email, backupsToKeep, gameId } = opts;
  const lines = [
    '# GATEKeeper .env — reconstructed by `npm run cli config reconstruct --env`',
    '# from the live deploy. Gitignored; never commit.',
    '#',
    '# Discord app creds live per-game in config/<game>.discord.json (which takes',
    '# precedence over any DISCORD_* here), so they are intentionally omitted.',
    '',
    `GAME=${env.GAME || gameId}`,
    `AWS_REGION=${region}`,
    'AWS_PROFILE=default',
  ];
  if (env.BASE_DOMAIN) lines.push(`BASE_DOMAIN=${env.BASE_DOMAIN}`);
  if (env.BOT_OWNER_IDS) lines.push(`BOT_OWNER_IDS=${env.BOT_OWNER_IDS}`);
  if (env.SCHEDULE_TZ) lines.push(`SCHEDULE_TZ=${env.SCHEDULE_TZ}`);
  if (email) lines.push(`BILLING_ALERT_EMAIL=${email}`);
  lines.push(`BACKUPS_TO_KEEP=${backupsToKeep || '7'}`);
  lines.push('');
  lines.push('# instance type, auto-shutdown, boot-timeout, ttl, extend match the');
  lines.push('# GameProfile defaults live, so they are omitted (profile is source of truth).');
  return lines.join('\n') + '\n';
}

module.exports = {
  lambdaEnvFromTemplate,
  billingEmailFromTemplate,
  backupsToKeepFromTemplate,
  appIdFromToken,
  prettyWorldsJson,
  discordJson,
  envFile,
};
