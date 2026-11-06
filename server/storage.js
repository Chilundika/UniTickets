'use strict';
// Attachment storage: Cloudflare R2 in production (private bucket, S3 API), a local folder in development.
// Files are only ever served through the staff API after a role check, never by public URL.
const fs = require('node:fs/promises');
const path = require('node:path');
const { DATA_DIR } = require('./db');
const { ON_VERCEL } = require('./config');

const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = process.env;
let r2 = null;
if (R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET) {
  const { AwsClient } = require('aws4fetch');
  r2 = {
    client: new AwsClient({ accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY, service: 's3', region: 'auto' }),
    base: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET}`,
  };
}
// Vercel's disk is read-only, so without R2 uploads are switched off there.
const enabled = !!r2 || !ON_VERCEL;
const LOCAL_DIR = path.join(DATA_DIR, 'uploads');
const localPath = (key) => path.join(LOCAL_DIR, key.replace(/[^\w.-]/g, '_'));

async function r2fetch(key, init) {
  const res = await r2.client.fetch(`${r2.base}/${encodeURIComponent(key).replace(/%2F/g, '/')}`, init);
  if (!res.ok && !(init.method === 'DELETE' && res.status === 404)) throw new Error(`R2 ${init.method} failed: ${res.status}`);
  return res;
}

async function put(key, data, mime) {
  if (r2) return void (await r2fetch(key, { method: 'PUT', body: data, headers: { 'Content-Type': mime } }));
  if (!enabled) throw new Error('File storage is not configured.');
  await fs.mkdir(LOCAL_DIR, { recursive: true });
  await fs.writeFile(localPath(key), data);
}
async function get(key) {
  if (r2) return Buffer.from(await (await r2fetch(key, { method: 'GET' })).arrayBuffer());
  return fs.readFile(localPath(key));
}
async function remove(key) {
  if (r2) return void (await r2fetch(key, { method: 'DELETE' }));
  await fs.rm(localPath(key), { force: true });
}

module.exports = { enabled, put, get, remove };
