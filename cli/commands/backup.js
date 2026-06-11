'use strict';
// Game-aware backup commands. Saves live in the deployed backup bucket under
// backups/<game-id>/<timestamp>.tar.gz (written by scripts/game/backup-server.sh),
// so listing/pulling/creating always scope to the active game.

const fs = require('fs');
const path = require('path');
const {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} = require('@aws-sdk/client-s3');
const { SSMClient, SendCommandCommand } = require('@aws-sdk/client-ssm');
const { GAME_ID, REGION, stackOutput } = require('../lib/context');

const PREFIX = `backups/${GAME_ID}/`;

async function listObjects() {
  const bucket = await stackOutput('BackupBucketName');
  const s3 = new S3Client({ region: REGION });
  const res = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: PREFIX }));
  const items = (res.Contents || [])
    .filter((o) => o.Key.endsWith('.tar.gz'))
    .sort((a, b) => b.LastModified - a.LastModified);
  return { bucket, items };
}

async function list() {
  const { bucket, items } = await listObjects();
  if (!items.length) {
    console.log(`No backups for ${GAME_ID} in s3://${bucket}/${PREFIX}`);
    return;
  }
  console.log(`Backups for ${GAME_ID} (s3://${bucket}/${PREFIX}):`);
  for (const o of items) {
    const name = o.Key.slice(PREFIX.length);
    const kb = (o.Size / 1024).toFixed(0);
    console.log(`  ${name}  ${kb} KB  ${o.LastModified.toISOString()}`);
  }
}

async function pull(which = 'latest') {
  const { bucket, items } = await listObjects();
  if (!items.length) {
    console.log(`No backups to pull for ${GAME_ID}.`);
    return;
  }
  const target = which === 'latest'
    ? items[0]
    : items.find((o) => o.Key.endsWith(which) || o.Key.slice(PREFIX.length) === which);
  if (!target) {
    console.error(`Backup '${which}' not found. Run 'npm run cli backup list' to see options.`);
    process.exit(1);
  }

  const outDir = path.join(process.cwd(), 'local', 'backups', GAME_ID);
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, path.basename(target.Key));

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

async function create() {
  const instanceId = await stackOutput('InstanceId');
  const ssm = new SSMClient({ region: REGION });
  await ssm.send(new SendCommandCommand({
    DocumentName: 'AWS-RunShellScript',
    InstanceIds: [instanceId],
    Parameters: { commands: ['/usr/local/bin/backup-server.sh'] },
    Comment: `GATEKeeper manual backup (${GAME_ID})`,
  }));
  console.log(
    `Backup triggered on ${instanceId} (runs in the background).\n` +
    `The server must be running. Check 'npm run cli backup list' in a minute.`
  );
}

module.exports = { list, pull, create };
