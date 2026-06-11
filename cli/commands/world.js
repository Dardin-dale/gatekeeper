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
const { SSMClient, SendCommandCommand } = require('@aws-sdk/client-ssm');
const { GAME_ID, REGION, stackOutput } = require('../lib/context');

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

module.exports = { list, push, pull, restore };
