// Accounts and sessions. Passwords are hashed with scrypt (built into Node).

import crypto from 'node:crypto';
import { get, run } from './db.js';
import { parseCookies, setCookie, unauthorized, forbidden, HttpError } from './lib/http.js';
import { config } from './config.js';

const SESSION_COOKIE = 'p2p_session';
const GUEST_COOKIE = 'p2p_guest';
const SESSION_DAYS = 30;
const ADMIN_MAX_AGE_MS = 12 * 3600e3;
const ADMIN_IDLE_MS = 60 * 60e3;

// Record security-relevant actions (admin sign-ins, settings changes, refunds…).
export function audit(req, action, detail = null) {
  try {
    run('INSERT INTO audit_log(user_id, email, action, detail, ip) VALUES(?, ?, ?, ?, ?)',
      [req?.user?.id ?? null, req?.user?.email ?? null, action, detail ? JSON.stringify(detail).slice(0, 1000) : null,
        String(req?.socket?.remoteAddress || '').replace(/^::ffff:/, '')]);
  } catch { /* never block the request */ }
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltB64, hashB64] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(actual, expected);
}

// Async versions for request handlers, so hashing never blocks other customers.
const scryptAsync = (password, salt, len) => new Promise((resolve, reject) => {
  crypto.scrypt(password, salt, len, { N: 16384, r: 8, p: 1 }, (err, key) => (err ? reject(err) : resolve(key)));
});
export async function hashPasswordAsync(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
const DUMMY_HASH = hashPassword('not-a-real-password');
export async function verifyPasswordAsync(password, stored = DUMMY_HASH) {
  const [scheme, saltB64, hashB64] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scryptAsync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// Repeated wrong passwords from one address (or for one email) are slowed down.
const failures = new Map(); // key -> { count, until }
const WINDOW_MS = 15 * 60e3;
export function checkLoginThrottle(ip, email) {
  const now = Date.now();
  for (const key of [`ip:${ip}`, `email:${email}`]) {
    const f = failures.get(key);
    if (f && f.until > now && f.count >= (key.startsWith('ip:') ? 20 : 8)) {
      throw new HttpError(429, 'Too many sign-in attempts. Wait a few minutes and try again.', 'too_many_attempts');
    }
  }
}
export function recordLoginFailure(ip, email) {
  const now = Date.now();
  for (const key of [`ip:${ip}`, `email:${email}`]) {
    const f = failures.get(key);
    failures.set(key, f && f.until > now ? { count: f.count + 1, until: f.until } : { count: 1, until: now + WINDOW_MS });
  }
  if (failures.size > 10000) failures.clear();
}
export function clearLoginFailures(email) { failures.delete(`email:${email}`); }

export function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400e3);
  run('INSERT INTO sessions(token, user_id, expires_at) VALUES(?, ?, ?)', [token, userId, expires.toISOString()]);
  setCookie(res, SESSION_COOKIE, token, { maxAge: SESSION_DAYS * 86400, secure: config.publicUrl.startsWith('https') });
  return token;
}

export function destroySession(req, res) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) run('DELETE FROM sessions WHERE token = ?', token);
  setCookie(res, SESSION_COOKIE, '', { maxAge: 0 });
}

// Attaches req.user (or null) and req.guestKey (a random id for visitors who are not signed in,
// so their cart and AI designs survive until they sign in).
export function attachIdentity(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  req.cookies = cookies;
  req.user = null;
  const token = cookies[SESSION_COOKIE];
  if (token) {
    const row = get(
      `SELECT u.id, u.email, u.name, u.role, u.locale, u.disabled, s.expires_at, s.created_at, s.last_seen FROM sessions s
       JOIN users u ON u.id = s.user_id WHERE s.token = ?`, token);
    if (row && !row.disabled && new Date(row.expires_at) > new Date()) {
      let valid = true;
      if (row.role === 'admin') {
        // Admin sessions are short: 12 hours at most, and 60 minutes without activity.
        const sqlDate = (s) => new Date(`${String(s).replace(' ', 'T')}Z`);
        const age = Date.now() - sqlDate(row.created_at).getTime();
        const idle = Date.now() - sqlDate(row.last_seen || row.created_at).getTime();
        if (age > ADMIN_MAX_AGE_MS || idle > ADMIN_IDLE_MS) {
          valid = false;
          run('DELETE FROM sessions WHERE token = ?', token);
        } else {
          run("UPDATE sessions SET last_seen = datetime('now') WHERE token = ?", token);
        }
      }
      if (valid) req.user = { id: row.id, email: row.email, name: row.name, role: row.role, locale: row.locale };
    }
  }
  let guest = cookies[GUEST_COOKIE];
  if (!guest || !/^[A-Za-z0-9_-]{20,}$/.test(guest)) {
    guest = crypto.randomBytes(18).toString('base64url');
    setCookie(res, GUEST_COOKIE, guest, { maxAge: 365 * 86400, secure: config.publicUrl.startsWith('https') });
  }
  req.guestKey = guest;
}

export function requireUser(req) {
  if (!req.user) throw unauthorized();
  return req.user;
}

export function requireAdmin(req) {
  if (!req.user) throw unauthorized();
  if (req.user.role !== 'admin') throw forbidden('Admins only.');
  return req.user;
}

// When a visitor signs in, move their guest cart and designs to the account.
export function adoptGuestData(guestKey, userId) {
  if (!guestKey) return;
  run('UPDATE cart_items SET user_id = ?, guest_key = NULL WHERE guest_key = ? AND user_id IS NULL', [userId, guestKey]);
  run('UPDATE designs SET user_id = ? WHERE guest_key = ? AND user_id IS NULL', [userId, guestKey]);
}

// Who owns a cart/design row: the signed-in user, or the guest key.
export function ownerClause(req, table = '') {
  const p = table ? `${table}.` : '';
  return req.user
    ? { sql: `${p}user_id = ?`, params: [req.user.id] }
    : { sql: `${p}guest_key = ? AND ${p}user_id IS NULL`, params: [req.guestKey] };
}
