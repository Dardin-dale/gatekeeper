'use strict';
// World bootstrap commands: push a local save up to S3 and restore archives
// onto the server. Seed archives live under bootstrap/<game-id>/ — a separate
// prefix from backups/<game-id>/ so the backup-rotation Lambda can never
// delete a seed. Both prefixes share one archive format (the data volume
// tarred from its root, exactly what backup-server.sh produces), and one
// on-host restore path (scripts/game/restore-world.sh via SSM).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  S3Client,
  ListObjectsV2Command,
  PutObjectCommand,
  GetObjectCommand,
} = require('@aws-sdk/client-s3');
const {
  SSMClient,
  SendCommandCommand,
  GetParameterCommand,
  PutParameterCommand,
} = require('@aws-sdk/client-ssm');
const { GAME_ID, REGION, stackOutput } = require('../lib/context');
const { parseFlags } = require('../lib/args');

const BOOTSTRAP_PREFIX = `bootstrap/${GAME_ID}/`;
const BACKUPS_PREFIX = `backups/${GAME_ID}/`;

// Local seed staging: expanded save dirs (and pulled seed archives) live in
// local/seeds/<game-id>/ — `world push <name>` resolves bare names here, and
// `world pull` downloads here. Mirrors local/backups/<game-id>/ for backup pull.
const SEEDS_DIR = path.join(process.cwd(), 'local', 'seeds', GAME_ID);

// Best-effort profile load (for layout hints). Needs a prior `npm run build`.
function gameProfile() {
  try {
    return require('../../dist/lib/games').getGameProfile(GAME_ID);
  } catch (e) {
    return undefined;
  }
}

async function listArchives(prefix) {
  const bucket = await stackOutput('BackupBucketName');
  const s3 = new S3Client({ region: REGION });
  const res = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
  const items = (res.Contents || [])
    .filter((o) => o.Key.endsWith('.tar.gz'))
    .sort((a, b) => b.LastModified - a.LastModified);
  return { bucket, items };
}

async function list() {
  const { bucket, items } = await listArchives(BOOTSTRAP_PREFIX);
  if (!items.length) {
    console.log(`No seed archives for ${GAME_ID} in s3://${bucket}/${BOOTSTRAP_PREFIX}`);
    console.log(`Push one with: npm run cli world push <save-dir|archive.tar.gz>`);
    return;
  }
  console.log(`Seed archives for ${GAME_ID} (s3://${bucket}/${BOOTSTRAP_PREFIX}):`);
  for (const o of items) {
    const name = o.Key.slice(BOOTSTRAP_PREFIX.length);
    const kb = (o.Size / 1024).toFixed(0);
    console.log(`  ${name}  ${kb} KB  ${o.LastModified.toISOString()}`);
  }
}

/**
 * Push a local save up as a seed archive.
 * Accepts either a directory laid out like the data volume root (it gets
 * tarred), or an existing .tar.gz in that format (e.g. one from backup pull).
 */
async function push(srcPath, name) {
  if (!srcPath) {
    console.error(
      'Usage: npm run cli world push <save-dir|archive.tar.gz|name> [name]\n' +
      'The directory must be laid out like the data volume root (see docs/cli.md).\n' +
      `Bare names resolve in the staging dir: ${SEEDS_DIR}`
    );
    process.exit(1);
  }
  // Resolve the source: an explicit path, or a bare name in the seed staging
  // dir (local/seeds/<game-id>/<name>/ or <name>.tar.gz).
  let src = path.resolve(srcPath);
  if (!fs.existsSync(src)) {
    const staged = [
      path.join(SEEDS_DIR, srcPath),
      path.join(SEEDS_DIR, `${srcPath}.tar.gz`),
    ].find((p) => fs.existsSync(p));
    if (!staged) {
      console.error(`Not found: ${src} (also tried ${path.join(SEEDS_DIR, srcPath)})`);
      process.exit(1);
    }
    src = staged;
    if (!name) name = srcPath.replace(/\.tar\.gz$/, '');
  }

  let archivePath = src;
  let cleanup = false;
  if (fs.statSync(src).isDirectory()) {
    // Layout hint: the save dir should contain the game's savePath subtree
    // (for Abiotic Factor: SaveGames/Server/Worlds/<WorldSaveName>/).
    const profile = gameProfile();
    if (profile && !fs.existsSync(path.join(src, profile.container.savePath))) {
      console.warn(
        `WARNING: ${src} has no '${profile.container.savePath}' inside it.\n` +
        `The archive is extracted at the data volume ROOT, so the layout must match\n` +
        `what the server expects. Continuing anyway — see docs/cli.md for the layout.`
      );
    }
    archivePath = path.join(os.tmpdir(), `gk-seed-${Date.now()}.tar.gz`);
    console.log(`Archiving ${src} ...`);
    const tar = spawnSync('tar', ['czf', archivePath, '-C', src, '.'], { stdio: 'inherit' });
    if (tar.status !== 0) {
      console.error('tar failed');
      process.exit(1);
    }
    cleanup = true;
  } else if (!src.endsWith('.tar.gz')) {
    console.error('Expected a directory or a .tar.gz archive.');
    process.exit(1);
  }

  const baseName = (name || path.basename(src).replace(/\.tar\.gz$/, '') || 'seed')
    .replace(/[^a-zA-Z0-9._-]/g, '_');
  const key = `${BOOTSTRAP_PREFIX}${baseName}.tar.gz`;

  const bucket = await stackOutput('BackupBucketName');
  const s3 = new S3Client({ region: REGION });
  const body = fs.readFileSync(archivePath);
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
  if (cleanup) fs.unlinkSync(archivePath);

  console.log(
    `Uploaded ${(body.length / 1024).toFixed(0)} KB -> s3://${bucket}/${key}\n` +
    `Restore it onto the (running) server with:\n` +
    `  npm run cli world restore ${baseName}.tar.gz`
  );
}

/**
 * Download a seed archive to the local staging dir (local/seeds/<game-id>/).
 * Mirrors `backup pull`; the result can be re-pushed or unpacked for editing.
 */
async function pull(which = 'latest') {
  const { bucket, items } = await listArchives(BOOTSTRAP_PREFIX);
  if (!items.length) {
    console.log(`No seed archives to pull for ${GAME_ID} in s3://${bucket}/${BOOTSTRAP_PREFIX}`);
    return;
  }
  const target = which === 'latest'
    ? items[0]
    : items.find((o) => o.Key.endsWith(which) || o.Key.slice(BOOTSTRAP_PREFIX.length) === which);
  if (!target) {
    console.error(`Seed archive '${which}' not found. Run 'npm run cli world list' to see options.`);
    process.exit(1);
  }

  fs.mkdirSync(SEEDS_DIR, { recursive: true });
  const outFile = path.join(SEEDS_DIR, path.basename(target.Key));

  const s3 = new S3Client({ region: REGION });
  const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: target.Key }));
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(outFile);
    obj.Body.on('error', reject);
    ws.on('error', reject);
    ws.on('finish', resolve);
    obj.Body.pipe(ws);
  });
  console.log(`Downloaded s3://${bucket}/${target.Key}\n        -> ${outFile}`);
}

/**
 * Restore an archive onto the server via SSM (the server must be running).
 * kind: 'bootstrap' (world restore) or 'backups' (backup restore).
 */
async function restore(which = 'latest', kind = 'bootstrap') {
  const prefix = kind === 'backups' ? BACKUPS_PREFIX : BOOTSTRAP_PREFIX;
  const { bucket, items } = await listArchives(prefix);
  if (!items.length) {
    console.log(`No archives to restore for ${GAME_ID} in s3://${bucket}/${prefix}`);
    return;
  }
  const target = which === 'latest'
    ? items[0]
    : items.find((o) => o.Key.endsWith(which) || o.Key.slice(prefix.length) === which);
  if (!target) {
    const listCmd = kind === 'backups' ? 'backup list' : 'world list';
    console.error(`Archive '${which}' not found. Run 'npm run cli ${listCmd}' to see options.`);
    process.exit(1);
  }

  const instanceId = await stackOutput('InstanceId');
  const ssm = new SSMClient({ region: REGION });
  await ssm.send(new SendCommandCommand({
    DocumentName: 'AWS-RunShellScript',
    InstanceIds: [instanceId],
    Parameters: {
      commands: [
        // Re-sync scripts first so a freshly-shipped restore-world.sh is present
        // even on an instance that booted before it landed in S3.
        'systemctl restart update-gatekeeper-scripts.service || true',
        `/usr/local/bin/restore-world.sh '${target.Key}'`,
      ],
    },
    Comment: `GATEKeeper world restore (${GAME_ID}: ${target.Key})`,
  }));
  console.log(
    `Restore of s3://${bucket}/${target.Key} triggered on ${instanceId}.\n` +
    `The game stops, the current data is backed up, the archive is extracted,\n` +
    `and the game restarts (the readiness ping posts to Discord when it's back).\n` +
    `NOTE: the world folder name inside the archive must match the active world's\n` +
    `'worldName' in config/${GAME_ID}.worlds.json, or the server won't load it.`
  );
}

// --- world add ---------------------------------------------------------------
// Append a world to the roster in config/<game>.worlds.json. This is a LOCAL
// edit only: the roster is read into the Lambda WORLDS_JSON at synth, so a new
// world goes live on the next `npm run deploy` — `add` never touches the running
// server. Config dir resolves the same way the CDK stack does (GATEKEEPER_CONFIG_DIR
// override, else ./config), so both read the same file.
const CONFIG_DIR = process.env.GATEKEEPER_CONFIG_DIR || path.join(process.cwd(), 'config');
const WORLDS_FILE = path.join(CONFIG_DIR, `${GAME_ID}.worlds.json`);

// Mirror of MOD_NAME_PATTERN in lib/lambdas/utils/world-config.ts.
const MOD_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Derive an ASCII save name from a friendly name: transliterate the common
// non-decomposing Latin/Norse letters (ð, þ, ø, æ, ß, ł), fold accents via NFKD,
// then drop anything left that isn't [A-Za-z0-9_]. So 'Emmumóðir' -> 'Emmumodir'
// and 'Café' -> 'Cafe' without an explicit --world; names that still reduce to
// fewer than 3 ASCII chars (e.g. non-Latin scripts) fail validation and prompt
// for --world.
const TRANSLIT = { ð: 'd', Ð: 'D', þ: 'th', Þ: 'Th', ø: 'o', Ø: 'O', æ: 'ae', Æ: 'Ae', ß: 'ss', ł: 'l', Ł: 'L' };
function asciiSaveName(name) {
  return name
    .replace(/[ðÐþÞøØæÆßłŁ]/g, (c) => TRANSLIT[c])
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_]/g, '');
}

// Validation mirrors validateWorldConfig in lib/lambdas/utils/world-config.ts
// (the authoritative gate at deploy). test/cli/world-add.test.ts cross-checks a
// built world against that TS validator so the two can't silently drift.
function validateNewWorld(w) {
  const errors = [];
  if (!w.name || !w.name.trim()) errors.push('name cannot be empty');
  else if (w.name.length < 3) errors.push('name must be at least 3 characters');
  else if (w.name.length > 50) errors.push('name cannot exceed 50 characters');

  if (!w.worldName || !w.worldName.trim()) errors.push('worldName (save name) cannot be empty');
  else if (w.worldName.length < 3) errors.push('worldName must be at least 3 characters');
  else if (w.worldName.length > 64) errors.push('worldName cannot exceed 64 characters');
  else if (!/^[a-zA-Z0-9_]+$/.test(w.worldName)) {
    errors.push("worldName can only contain letters, numbers, and underscores (pass --world=<ascii> explicitly)");
  }

  if (!w.password || !w.password.trim()) errors.push('password cannot be empty');
  else if (w.password.length < 5) errors.push('password must be at least 5 characters');

  if (w.discordServerId && !/^\d+$/.test(w.discordServerId)) errors.push('guild (discordServerId) must be numeric');

  if (w.mods) for (const m of w.mods) if (!MOD_NAME_PATTERN.test(m)) errors.push(`invalid mod name '${m}' (letters, digits, . _ - only)`);
  return errors;
}

/**
 * Build a new-world object and validate it against the existing roster. Pure (no
 * IO) so it's unit-testable. `opts`: { name, world?, password, guild?, admins?,
 * default?, args?, mods? }. Returns { world, errors }.
 */
function buildWorld(existing, opts) {
  const errors = [];
  const name = (opts.name || '').trim();
  const worldName = (opts.world || asciiSaveName(name)).trim();
  const world = { name, worldName, password: opts.password, discordServerId: opts.guild };
  if (opts.admins) world.adminIds = opts.admins;
  if (opts.default) world.default = true;
  if (opts.args) world.extraArgs = opts.args;
  if (opts.mods && opts.mods.length) world.mods = opts.mods;

  errors.push(...validateNewWorld(world));

  // Duplicate name/worldName (case-insensitive) collides with the resolver,
  // which matches EITHER field (see commands/start.ts, world-config.ts).
  const lname = name.toLowerCase();
  const lworld = worldName.toLowerCase();
  for (const w of existing) {
    if (w.name && w.name.toLowerCase() === lname) errors.push(`a world named '${w.name}' already exists`);
    if (w.worldName && w.worldName.toLowerCase() === lworld) errors.push(`worldName '${w.worldName}' is already in use`);
  }

  // At most one default per guild (mirrors parseWorldConfigsFromJson's guard).
  if (opts.default && opts.guild) {
    const clash = existing.find((w) => w.default && (w.discordServerId || w.discordId) === opts.guild);
    if (clash) errors.push(`world '${clash.name}' is already the default for guild ${opts.guild} — unset it first, or omit --default`);
  }

  return { world, errors };
}

const ADD_USAGE =
  'Usage: npm run cli world add <name> --password=<pw> [--guild=<id>] [--world=<save>]\n' +
  '                              [--default] [--admins="id1 id2"] [--args="<launch args>"] [--mods=A,B]\n' +
  '  <name>       friendly label players pass to /<cmd> start\n' +
  '  --world      on-disk save name (default: ASCII-folded <name>)\n' +
  '  --guild      Discord server id (default: inferred if the roster uses exactly one)\n' +
  '  --default    make this the guild\'s default world (only one allowed per guild)';

/**
 * Add a world to config/<game>.worlds.json (local edit; takes effect on next deploy).
 */
async function add(...rest) {
  const { flags, positional } = parseFlags(rest);
  const name = positional[0] || (typeof flags.name === 'string' ? flags.name : undefined);
  if (!name || typeof flags.password !== 'string') {
    console.error(ADD_USAGE);
    process.exit(1);
  }

  let existing = [];
  if (fs.existsSync(WORLDS_FILE)) {
    try {
      existing = JSON.parse(fs.readFileSync(WORLDS_FILE, 'utf8'));
    } catch (e) {
      console.error(`Could not parse ${WORLDS_FILE}: ${e.message}`);
      process.exit(1);
    }
    if (!Array.isArray(existing)) {
      console.error(`${WORLDS_FILE} is not a JSON array of worlds.`);
      process.exit(1);
    }
  } else {
    console.log(`No roster yet — creating ${WORLDS_FILE}.`);
  }

  // Infer the guild when the roster already uses exactly one.
  let guild = typeof flags.guild === 'string' ? flags.guild : undefined;
  if (!guild) {
    const guilds = [...new Set(existing.map((w) => w.discordServerId || w.discordId).filter(Boolean))];
    if (guilds.length === 1) {
      guild = guilds[0];
      console.log(`Inferred --guild=${guild} from the existing roster.`);
    }
  }
  if (!guild) {
    console.error('Could not infer --guild; pass --guild=<discordServerId> (a world with no guild can\'t be started from any server).');
    process.exit(1);
  }

  const mods = typeof flags.mods === 'string'
    ? flags.mods.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;

  const { world, errors } = buildWorld(existing, {
    name,
    world: typeof flags.world === 'string' ? flags.world : undefined,
    password: flags.password,
    guild,
    admins: typeof flags.admins === 'string' ? flags.admins : undefined,
    default: !!flags.default,
    args: typeof flags.args === 'string' ? flags.args : undefined,
    mods,
  });

  if (errors.length) {
    console.error(`Cannot add world '${name}':`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  existing.push(world);
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(WORLDS_FILE, JSON.stringify(existing, null, 2) + '\n');

  console.log(
    `Added world '${world.name}' (save: ${world.worldName}) to ${WORLDS_FILE}.\n` +
    `The roster now has ${existing.length} world(s). This is a LOCAL change —\n` +
    `deploy it live with:  GAME=${GAME_ID} npm run deploy`
  );
}

// --- world switch ------------------------------------------------------------
// Set a guild's DEFAULT world — the SSM param a bare `/<cmd> start` resolves
// (`/gatekeeper/<game>/discord/<guild>/default-world`, read by start/worlds/
// status/stop/schedule). This is durable config, NOT the live `active-world`
// (which /start rewrites): switching the default never touches a running server;
// it takes effect on the next start. It's the only writer of this param.
function guildDefaultParam(gameId, guildId) {
  return `/gatekeeper/${gameId}/discord/${guildId}/default-world`;
}

/**
 * Resolve a switch target against the roster. Pure (no IO) for testability.
 * `opts`: { guild?, name?, gameId }. Returns { guild, guildWorlds, match, param, errors }.
 * Infers the guild when the roster uses exactly one; validates the named world
 * belongs to that guild (matching name OR worldName, case-insensitive).
 */
function resolveSwitch(worlds, opts) {
  const errors = [];
  const gid = (w) => w.discordServerId || w.discordId;

  let guild = opts.guild;
  if (!guild) {
    const guilds = [...new Set(worlds.map(gid).filter(Boolean))];
    if (guilds.length === 1) guild = guilds[0];
  }
  if (!guild) {
    errors.push('could not infer --guild; pass --guild=<discordServerId>');
    return { guild: undefined, guildWorlds: [], match: undefined, param: undefined, errors };
  }

  const guildWorlds = worlds.filter((w) => gid(w) === guild);
  const param = guildDefaultParam(opts.gameId, guild);

  let match;
  if (opts.name) {
    const q = opts.name.toLowerCase();
    match = guildWorlds.find(
      (w) => (w.name || '').toLowerCase() === q || (w.worldName || '').toLowerCase() === q
    );
    if (!match) {
      const names = guildWorlds.map((w) => w.name).join(', ') || '(none)';
      errors.push(`no world '${opts.name}' in guild ${guild}. Available: ${names}`);
    }
  }
  return { guild, guildWorlds, match, param, errors };
}

/**
 * Switch (or, with no name, show) a guild's default world.
 */
async function switchDefault(...rest) {
  const { flags, positional } = parseFlags(rest);
  const name = positional[0] || (typeof flags.name === 'string' ? flags.name : undefined);

  let worlds = [];
  if (fs.existsSync(WORLDS_FILE)) {
    try {
      worlds = JSON.parse(fs.readFileSync(WORLDS_FILE, 'utf8'));
    } catch (e) {
      console.error(`Could not parse ${WORLDS_FILE}: ${e.message}`);
      process.exit(1);
    }
  }
  if (!Array.isArray(worlds) || worlds.length === 0) {
    console.error(`No worlds in ${WORLDS_FILE}. Add one first: npm run cli world add <name> --password=<pw>`);
    process.exit(1);
  }

  const guildFlag = typeof flags.guild === 'string' ? flags.guild : undefined;
  const { guild, guildWorlds, match, param, errors } = resolveSwitch(worlds, {
    guild: guildFlag,
    name,
    gameId: GAME_ID,
  });
  if (errors.length && !guild) {
    console.error(errors.join('\n'));
    process.exit(1);
  }

  const ssm = new SSMClient({ region: REGION });

  // No name → show the guild's current default and the options.
  if (!name) {
    let current;
    try {
      const r = await ssm.send(new GetParameterCommand({ Name: param }));
      current = r.Parameter && r.Parameter.Value;
    } catch (err) {
      if (err.name !== 'ParameterNotFound') throw err;
    }
    const configDefault = (guildWorlds.find((w) => w.default) || guildWorlds[0] || {}).name;
    console.log(`Default world for guild ${guild}: ${current || `${configDefault} (config default — no SSM override set)`}`);
    console.log(`Worlds in this guild: ${guildWorlds.map((w) => w.name).join(', ') || '(none)'}`);
    console.log(`Switch with: npm run cli world switch <name> [--guild=<id>]`);
    return;
  }

  if (errors.length) {
    console.error(errors.join('\n'));
    process.exit(1);
  }

  if (flags.dry) {
    console.log(`[dry-run] would set ${param} = ${match.name}`);
    return;
  }

  await ssm.send(new PutParameterCommand({ Name: param, Value: match.name, Type: 'String', Overwrite: true }));
  console.log(
    `Set '${match.name}' (save: ${match.worldName}) as the default world for guild ${guild}.\n` +
    `A bare \`/<cmd> start\` now loads it. This does NOT restart a running server — it applies on the next start.`
  );
}

module.exports = { list, push, pull, restore, add, buildWorld, switchDefault, resolveSwitch };
