// Runtime configuration. Values come from environment variables, then an optional .env file
// (in the project folder or the data folder). Business settings (prices, taxes, API keys…)
// live in the database and are edited from the admin panel.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m || line.trim().startsWith('#')) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

loadDotEnv(path.join(ROOT, '.env'));
const dataDir = path.resolve(process.env.P2P_DATA_DIR || path.join(ROOT, 'storage'));
loadDotEnv(path.join(dataDir, '.env'));

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

export const config = {
  root: ROOT,
  version: pkg.version,
  publicDir: path.join(ROOT, 'public'),
  dataDir,
  dbFile: path.join(dataDir, 'prompt2print.db'),
  // Private folders: never served over HTTP.
  modelsDir: path.join(dataDir, 'private', 'models'),
  gcodeDir: path.join(dataDir, 'private', 'gcode'),
  // Public product photos (rendered images, not 3D files).
  mediaDir: path.join(dataDir, 'media'),
  logsDir: path.join(dataDir, 'logs'),
  port: Number(process.env.P2P_PORT || process.env.PORT || 3939),
  host: process.env.P2P_HOST || '127.0.0.1',
  desktop: process.env.P2P_DESKTOP === '1',
  publicUrl: process.env.P2P_PUBLIC_URL || '', // e.g. https://prompt2print.com (used for payment redirects)
  production: process.env.NODE_ENV === 'production',
};

// Demo mode (sample accounts, sample orders, simulated printers, test cards) is OFF unless
// P2P_DEMO=1 is set explicitly. The shop runs for real by default.
config.demo = process.env.P2P_DEMO === '1';

// The shop's admin account, created on first start.
config.adminEmail = process.env.P2P_ADMIN_EMAIL || 'Prompt2Print.admin@gmail.com';
// The admin password is never in the source. It comes from P2P_ADMIN_PASSWORD (or a ready scrypt
// hash in P2P_ADMIN_PASSWORD_HASH), usually from a .env file; otherwise the shop asks for it once,
// from this computer only, at the first start.
config.adminPasswordHash = process.env.P2P_ADMIN_PASSWORD_HASH || '';
// Printing limits of the shop's printer (Bambu Lab P2S): models must fit inside this cube.
config.maxModelMm = Number(process.env.P2P_MAX_MODEL_MM || 250);

for (const dir of [config.dataDir, config.modelsDir, config.gcodeDir, config.mediaDir, config.logsDir]) {
  fs.mkdirSync(dir, { recursive: true });
}
