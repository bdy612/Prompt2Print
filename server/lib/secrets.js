// Secrets at rest. API keys and payment keys are encrypted with AES-256-GCM before they are
// written to the database. The master key lives in a separate file in the data folder
// (data/.master.key, readable only by the shop's Windows/Linux user), or in P2P_MASTER_KEY.
// Someone who copies the database file alone cannot read the keys.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';

const KEY_FILE = path.join(config.dataDir, '.master.key');
let masterKey = null;

function loadMasterKey() {
  if (masterKey) return masterKey;
  if (process.env.P2P_MASTER_KEY) {
    masterKey = crypto.createHash('sha256').update(process.env.P2P_MASTER_KEY).digest();
    return masterKey;
  }
  try {
    const raw = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (raw.length >= 64) { masterKey = Buffer.from(raw, 'hex'); return masterKey; }
  } catch { /* first start */ }
  masterKey = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, masterKey.toString('hex'), { mode: 0o600 });
  try { fs.chmodSync(KEY_FILE, 0o600); } catch { /* Windows ignores modes */ }
  return masterKey;
}

export function encryptSecret(plain) {
  if (!plain) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', loadMasterKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return `enc:v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

export function decryptSecret(stored) {
  if (!stored) return '';
  if (!String(stored).startsWith('enc:v1:')) return String(stored); // legacy plain value
  const [, , ivB64, tagB64, dataB64] = String(stored).split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', loadMasterKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

export const maskSecret = (v) => (v ? `••••${String(v).slice(-4)}` : '');
