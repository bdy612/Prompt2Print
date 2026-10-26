// SQLite database (built into Node 22.13+ as node:sqlite — nothing to install).

import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { HttpError } from './lib/http.js';

export const db = new DatabaseSync(config.dbFile);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer',
  locale TEXT NOT NULL DEFAULT 'en',
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS addresses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT, full_name TEXT NOT NULL, phone TEXT,
  line1 TEXT NOT NULL, line2 TEXT, city TEXT NOT NULL, region TEXT, postal_code TEXT,
  country TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS materials (
  code TEXT PRIMARY KEY,
  name_en TEXT NOT NULL, name_ar TEXT NOT NULL,
  desc_en TEXT, desc_ar TEXT,
  price_per_gram REAL NOT NULL,          -- US dollars per gram
  density REAL NOT NULL,                 -- g/cm³
  process TEXT NOT NULL DEFAULT 'fdm',   -- fdm | resin
  nozzle_temp INTEGER, bed_temp INTEGER,
  colors TEXT NOT NULL DEFAULT '[]',     -- [{code, name_en, name_ar, hex}]
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tax_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  country TEXT NOT NULL,                 -- ISO code or '*' for everywhere else
  region TEXT NOT NULL DEFAULT '*',      -- state/province or '*'
  rate REAL NOT NULL,                    -- percent, e.g. 15
  label TEXT,
  UNIQUE(country, region)
);
CREATE TABLE IF NOT EXISTS shipping_zones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name_en TEXT NOT NULL, name_ar TEXT NOT NULL,
  countries TEXT NOT NULL,               -- JSON array of ISO codes, or ["*"]
  base_cents INTEGER NOT NULL,
  per_kg_cents INTEGER NOT NULL,
  volumetric_divisor INTEGER NOT NULL DEFAULT 5000,   -- cm³ per kg
  min_days INTEGER NOT NULL DEFAULT 2, max_days INTEGER NOT NULL DEFAULT 5,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name_en TEXT NOT NULL, name_ar TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,                  -- catalog | ai | upload
  owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  file_name TEXT NOT NULL,               -- inside the private models folder
  analysis TEXT NOT NULL,                -- JSON (scale 1)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  model_id TEXT REFERENCES models(id),
  name_en TEXT NOT NULL, name_ar TEXT NOT NULL,
  desc_en TEXT, desc_ar TEXT,
  default_material TEXT NOT NULL DEFAULT 'PLA',
  default_color TEXT,
  allowed_materials TEXT NOT NULL DEFAULT '["PLA","PETG","ABS","TPU","RESIN"]',
  default_scale REAL NOT NULL DEFAULT 1,
  min_scale REAL NOT NULL DEFAULT 0.5,
  max_scale REAL NOT NULL DEFAULT 2,
  default_infill INTEGER NOT NULL DEFAULT 20,
  images TEXT NOT NULL DEFAULT '[]',     -- JSON array of /media/... URLs
  tags TEXT,
  featured INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  rating_avg REAL NOT NULL DEFAULT 0,
  rating_count INTEGER NOT NULL DEFAULT 0,
  sold_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  author_name TEXT NOT NULL,
  rating INTEGER NOT NULL,
  title TEXT, body TEXT,
  locale TEXT NOT NULL DEFAULT 'en',
  verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS wishlist (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, product_id)
);
CREATE TABLE IF NOT EXISTS designs (
  id TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  guest_key TEXT,
  parent_id TEXT,
  prompt TEXT NOT NULL,
  seed INTEGER NOT NULL DEFAULT 1,
  provider TEXT NOT NULL,
  provider_task_id TEXT,
  ip TEXT,
  status TEXT NOT NULL DEFAULT 'generating',  -- generating | ready | failed
  progress INTEGER NOT NULL DEFAULT 0,
  model_id TEXT REFERENCES models(id),
  title_en TEXT, title_ar TEXT,
  thumb TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS cart_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  guest_key TEXT,
  kind TEXT NOT NULL,                    -- product | design
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  design_id TEXT REFERENCES designs(id) ON DELETE CASCADE,
  material TEXT NOT NULL, color TEXT NOT NULL,
  scale REAL NOT NULL, infill INTEGER NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL,                  -- pending_payment | paid | in_queue | printing | printed | packed | shipped | delivered | cancelled | refunded
  address TEXT NOT NULL,                 -- JSON snapshot
  pricing TEXT NOT NULL,                 -- JSON breakdown snapshot
  total_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  payment_provider TEXT, payment_ref TEXT,
  paid_at TEXT,
  carrier TEXT, tracking_number TEXT,
  refunded_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  product_id INTEGER, design_id TEXT, model_id TEXT NOT NULL,
  title_en TEXT NOT NULL, title_ar TEXT NOT NULL,
  thumb TEXT,
  material TEXT NOT NULL, color TEXT NOT NULL, color_hex TEXT,
  scale REAL NOT NULL, infill INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  size_mm TEXT, weight_g REAL NOT NULL,
  needs_supports INTEGER NOT NULL DEFAULT 0,
  filament_cents INTEGER NOT NULL, tax_cents INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider TEXT NOT NULL, provider_ref TEXT,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL,                  -- pending | succeeded | failed | refunded
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,
  reason TEXT, provider_ref TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS printers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  driver TEXT NOT NULL,                  -- simulator | octoprint | moonraker | bambu
  url TEXT, api_key TEXT, serial TEXT, access_code TEXT,
  flavor TEXT NOT NULL DEFAULT 'marlin',
  bed TEXT NOT NULL,                     -- {"x":256,"y":256,"z":256}
  materials TEXT NOT NULL,               -- ["PLA","PETG"]
  slicer_profile TEXT,                   -- optional path to a PrusaSlicer .ini
  active INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'idle',   -- idle | printing | paused | awaiting_clear | error | offline
  status_detail TEXT,
  current_job_id INTEGER,
  progress REAL NOT NULL DEFAULT 0,
  last_seen TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS print_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  order_item_id INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  copy_index INTEGER NOT NULL DEFAULT 1,
  model_id TEXT NOT NULL,
  status TEXT NOT NULL,                  -- queued | slicing | ready | printing | paused | printed | failed | cancelled
  held INTEGER NOT NULL DEFAULT 0,
  position REAL NOT NULL,
  printer_id INTEGER REFERENCES printers(id) ON DELETE SET NULL,
  sliced_for TEXT,                       -- flavor/bed the G-code was made for
  gcode_file TEXT,
  stats TEXT,
  progress REAL NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT, finished_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON print_jobs(status);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER, email TEXT, action TEXT NOT NULL, detail TEXT, ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

db.exec(SCHEMA);
// Small migrations for databases created by earlier builds.
for (const sql of [
  'ALTER TABLE designs ADD COLUMN ip TEXT',
  'ALTER TABLE orders ADD COLUMN display_currency TEXT',
  'ALTER TABLE orders ADD COLUMN fx_rate REAL',
  'ALTER TABLE orders ADD COLUMN charged_amount REAL',
  'ALTER TABLE printers ADD COLUMN ams TEXT',
  'ALTER TABLE print_jobs ADD COLUMN ams_slot INTEGER',
  "ALTER TABLE sessions ADD COLUMN last_seen TEXT",
]) { try { db.exec(sql); } catch { /* already there */ } }

// Helpers ---------------------------------------------------------------------------------------
const cache = new Map();
function stmt(sql) {
  let s = cache.get(sql);
  if (!s) { s = db.prepare(sql); cache.set(sql, s); }
  return s;
}

// Only plain values can be bound; objects from a crafted JSON body become a 400, not a crash.
const bindable = (v) => {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v !== null && typeof v === 'object' && !(v instanceof Uint8Array)) throw new HttpError(400, 'Invalid value in request.', 'bad_request');
  return v;
};
const norm = (params) => (params === undefined ? [] : Array.isArray(params) ? params : [params]).map(bindable);

export const all = (sql, params) => stmt(sql).all(...norm(params));
export const get = (sql, params) => stmt(sql).get(...norm(params));
export const run = (sql, params) => stmt(sql).run(...norm(params));

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function parseJson(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

// Settings stored as JSON values.
export function getSetting(key, fallback = null) {
  const row = get('SELECT value FROM settings WHERE key = ?', key);
  return row ? parseJson(row.value, fallback) : fallback;
}

export function setSetting(key, value) {
  run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, JSON.stringify(value)]);
}
