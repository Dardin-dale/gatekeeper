'use strict';
// Game-aware mod-library commands. The library lives in the deployed backup
// bucket under mods/<Name>/{metadata.json,files/...} (the bucket is per-game,
// so no game prefix). Worlds opt in by listing library names in their `mods`
// array (config/<game>.worlds.json); the host start script installs them into
// the profile's kind targetPath on world start. See docs/mods.md.
//
// Sources are per-game (GameProfile.mods.source): `add` ingests anything you
// downloaded yourself (Nexus etc. — file, directory, or zip); `import` pulls
// straight from Thunderstore for games with a community there (e.g. Valheim).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectsCommand,
} = require('@aws-sdk/client-s3');
const { GAME_ID, REGION, stackOutput } = require('../lib/context');

const PREFIX = 'mods/';
const MOD_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// The active game's compiled profile (same pattern as lib/discord-commands.js).
function gameModsSpec() {
  try {
    const { ACTIVE_GAME } = require('../../dist/lib/games');
    return ACTIVE_GAME.mods;
  } catch (e) {
    console.warn('WARN: build not found (npm run build) — skipping mod-kind validation.');
    return undefined;
  }
}

function s3() {
  return new S3Client({ region: REGION });
}

async function getJson(client, bucket, key) {
  try {
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return JSON.parse(await res.Body.transformToString());
  } catch (e) {
    return undefined;
  }
}

function walkFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, base));
    else out.push({ full, rel: path.relative(base, full).split(path.sep).join('/') });
  }
  return out;
}

function unzipTo(zipPath, destDir) {
  execFileSync('unzip', ['-o', '-q', zipPath, '-d', destDir]);
}

// Resolve a local path (file, directory, or .zip) to a [{full, rel}] payload.
function collectFiles(srcPath) {
  const stat = fs.statSync(srcPath);
  if (stat.isDirectory()) return { files: walkFiles(srcPath), cleanup: undefined };
  if (srcPath.toLowerCase().endsWith('.zip')) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gatekeeper-mod-'));
    unzipTo(srcPath, tmp);
    return { files: walkFiles(tmp), cleanup: tmp };
  }
  return { files: [{ full: srcPath, rel: path.basename(srcPath) }], cleanup: undefined };
}

// Thunderstore zips carry package meta alongside the payload; BepInEx mods
// often nest under (BepInEx/)plugins/. Drop the meta, strip the common prefix.
const TS_META = new Set(['manifest.json', 'icon.png', 'README.md', 'CHANGELOG.md', 'LICENSE']);
function cleanThunderstorePayload(files) {
  let payload = files.filter((f) => !TS_META.has(f.rel));
  for (const prefix of ['BepInEx/plugins/', 'plugins/']) {
    if (payload.length && payload.every((f) => f.rel.startsWith(prefix))) {
      payload = payload.map((f) => ({ ...f, rel: f.rel.slice(prefix.length) }));
      break;
    }
  }
  return payload;
}

async function upload(name, files, metadata) {
  if (!files.length) throw new Error('No files to upload — empty mod payload?');
  const bucket = await stackOutput('BackupBucketName');
  const client = s3();
  for (const f of files) {
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: `${PREFIX}${name}/files/${f.rel}`,
      Body: fs.readFileSync(f.full),
    }));
  }
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: `${PREFIX}${name}/metadata.json`,
    Body: JSON.stringify({ ...metadata, files: files.map((f) => f.rel) }, null, 2),
    ContentType: 'application/json',
  }));
  console.log(`Uploaded '${name}' (${files.length} file(s), kind: ${metadata.kind}) to s3://${bucket}/${PREFIX}${name}/`);
}

// Resolve + validate the install kind against the active game's profile.
function resolveKind(requested, spec) {
  const kinds = spec ? Object.keys(spec.kinds) : [];
  if (!requested) {
    if (kinds.length === 1) return kinds[0];
    throw new Error(
      kinds.length
        ? `--kind is required (this game supports: ${kinds.join(', ')})`
        : `--kind is required (and ${GAME_ID} declares no mod kinds — is this the right GAME?)`
    );
  }
  if (spec && !spec.kinds[requested]) {
    throw new Error(`Kind '${requested}' not supported by ${GAME_ID} (supported: ${kinds.join(', ') || 'none'})`);
  }
  return requested;
}

function parseFlags(rest) {
  const flags = {};
  const positional = [];
  for (const arg of rest) {
    const m = /^--([a-z]+)(?:=(.*))?$/.exec(arg);
    if (m) flags[m[1]] = m[2] ?? true;
    else positional.push(arg);
  }
  return { flags, positional };
}

async function add(...rest) {
  const { flags, positional } = parseFlags(rest);
  const [srcPath, nameArg] = positional;
  if (!srcPath) throw new Error('Usage: mods add <file|dir|zip> [name] [--kind k] [--url u] [--version v]');

  const spec = gameModsSpec();
  const kind = resolveKind(flags.kind, spec);
  const name = nameArg || path.basename(srcPath).replace(/\.(zip|dll|pak)$/i, '');
  if (!MOD_NAME_PATTERN.test(name)) {
    throw new Error(`Mod name '${name}' must match ${MOD_NAME_PATTERN} (pass an explicit name)`);
  }

  const { files, cleanup } = collectFiles(srcPath);
  try {
    await upload(name, files, {
      name,
      kind,
      version: flags.version,
      sourceUrl: flags.url,
      source: 'manual',
      addedAt: new Date().toISOString(),
    });
  } finally {
    if (cleanup) fs.rmSync(cleanup, { recursive: true, force: true });
  }
}

// mods import <Namespace/ModName[@version]> — Thunderstore games only.
async function importMod(ref, ...rest) {
  const spec = gameModsSpec();
  if (!spec || !spec.source || spec.source.type !== 'thunderstore') {
    throw new Error(
      `${GAME_ID} has no Thunderstore community — download the mod yourself and use 'mods add'.` +
      (spec && spec.source && spec.source.portalUrl ? ` Mods portal: ${spec.source.portalUrl}` : '')
    );
  }
  if (!ref || !ref.includes('/')) {
    throw new Error('Usage: mods import <Namespace/ModName[@version]>');
  }
  const { flags } = parseFlags(rest);
  const [namespace, nameVer] = ref.split('/');
  let [name, version] = nameVer.split('@');

  if (!version) {
    const api = `https://thunderstore.io/api/experimental/package/${namespace}/${name}/`;
    const res = await fetch(api);
    if (!res.ok) throw new Error(`Thunderstore lookup failed (${res.status}) for ${namespace}/${name}`);
    const pkg = await res.json();
    version = pkg.latest.version_number;
  }

  const url = `https://thunderstore.io/package/download/${namespace}/${name}/${version}/`;
  console.log(`Downloading ${namespace}/${name}@${version} ...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gatekeeper-ts-'));
  try {
    const zipPath = path.join(tmp, 'pkg.zip');
    fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
    const extractDir = path.join(tmp, 'pkg');
    fs.mkdirSync(extractDir);
    unzipTo(zipPath, extractDir);

    const all = walkFiles(extractDir);
    const manifestFile = all.find((f) => f.rel === 'manifest.json');
    const manifest = manifestFile ? JSON.parse(fs.readFileSync(manifestFile.full, 'utf-8')) : {};
    const payload = cleanThunderstorePayload(all);

    await upload(name, payload, {
      name,
      kind: resolveKind(flags.kind, spec),
      version,
      source: 'thunderstore',
      sourceUrl: `https://thunderstore.io/c/${spec.source.community}/p/${namespace}/${name}/`,
      dependencies: manifest.dependencies || [],
      addedAt: new Date().toISOString(),
    });
    const deps = (manifest.dependencies || []).filter((d) => !/^BepInEx-BepInExPack/.test(d));
    if (deps.length) {
      console.log('NOTE: dependencies are not auto-imported. This mod declares:');
      for (const d of deps) console.log(`  - ${d}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function list() {
  const bucket = await stackOutput('BackupBucketName');
  const client = s3();
  const res = await client.send(new ListObjectsV2Command({
    Bucket: bucket, Prefix: PREFIX, Delimiter: '/',
  }));
  const names = (res.CommonPrefixes || []).map((p) => p.Prefix.slice(PREFIX.length).replace(/\/$/, ''));
  if (!names.length) {
    console.log(`Mod library is empty (s3://${bucket}/${PREFIX}). Add one with 'mods add'.`);
    return;
  }
  console.log(`Mod library for ${GAME_ID} (s3://${bucket}/${PREFIX}):`);
  const metas = await Promise.all(names.map((n) => getJson(client, bucket, `${PREFIX}${n}/metadata.json`)));
  names.forEach((n, i) => {
    const m = metas[i] || {};
    const bits = [m.kind || '?', m.version ? `v${m.version}` : null, m.source].filter(Boolean);
    console.log(`  ${n}  (${bits.join(', ')})`);
  });
}

async function info(name) {
  if (!name) throw new Error('Usage: mods info <name>');
  const bucket = await stackOutput('BackupBucketName');
  const meta = await getJson(s3(), bucket, `${PREFIX}${name}/metadata.json`);
  if (!meta) {
    console.error(`Mod '${name}' not found. Run 'npm run cli mods list'.`);
    process.exit(1);
  }
  console.log(JSON.stringify(meta, null, 2));
}

async function remove(name) {
  if (!name) throw new Error('Usage: mods remove <name>');
  const bucket = await stackOutput('BackupBucketName');
  const client = s3();
  const res = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${PREFIX}${name}/` }));
  const keys = (res.Contents || []).map((o) => ({ Key: o.Key }));
  if (!keys.length) {
    console.log(`Mod '${name}' not found — nothing to remove.`);
    return;
  }
  await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }));
  console.log(`Removed '${name}' (${keys.length} object(s)) from the library.`);
  console.log(`Remember to drop it from any world's "mods" in config/${GAME_ID}.worlds.json and redeploy.`);
}

module.exports = { list, add, remove, info, importMod };
