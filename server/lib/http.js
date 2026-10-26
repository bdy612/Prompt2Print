// A small HTTP toolkit on top of node:http: routing with :params, JSON bodies, cookies,
// static files and consistent errors. No external dependencies.

import fs from 'node:fs';
import path from 'node:path';

export class HttpError extends Error {
  constructor(status, message, code, extra) {
    super(message);
    this.status = status;
    this.code = code || 'error';
    this.extra = extra;
  }
}

export const bad = (msg, code = 'bad_request', extra) => new HttpError(400, msg, code, extra);
export const unauthorized = (msg = 'Please sign in to continue.') => new HttpError(401, msg, 'unauthorized');
export const forbidden = (msg = 'You do not have access to this.') => new HttpError(403, msg, 'forbidden');
export const notFound = (msg = 'Not found.') => new HttpError(404, msg, 'not_found');

export class Router {
  constructor() { this.routes = []; }
  add(method, pattern, ...handlers) {
    const keys = [];
    const rx = new RegExp('^' + pattern.replace(/\/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
    this.routes.push({ method, rx, keys, handlers });
    return this;
  }
  get(p, ...h) { return this.add('GET', p, ...h); }
  post(p, ...h) { return this.add('POST', p, ...h); }
  put(p, ...h) { return this.add('PUT', p, ...h); }
  patch(p, ...h) { return this.add('PATCH', p, ...h); }
  delete(p, ...h) { return this.add('DELETE', p, ...h); }
  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
      const m = pathname.match(r.rx);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); }); // URIError → 400 in index.js
      return { route: r, params };
    }
    return null;
  }
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function setCookie(res, name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path || '/'}`, 'SameSite=Lax'];
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.secure) parts.push('Secure');
  const prev = res.getHeader('Set-Cookie');
  const list = Array.isArray(prev) ? prev : prev ? [prev] : [];
  res.setHeader('Set-Cookie', [...list, parts.join('; ')]);
}

export function readBody(req, limitBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new HttpError(413, 'Upload is too large.', 'too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw bad('Invalid JSON body.'); }
}

export function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

export function mimeFor(file) { return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'; }

// Serve a file from `root` only (no path traversal). Returns false when the file does not exist.
export function serveStatic(req, res, root, relPath, { maxAge = 0, immutable = false } = {}) {
  const safe = path.normalize(relPath).replace(/^([/\\])+/, '');
  if (safe.split(/[/\\]/).includes('..')) return false;
  const file = path.join(root, safe);
  if (!file.startsWith(root)) return false;
  let stat;
  try { stat = fs.statSync(file); } catch { return false; }
  if (!stat.isFile()) return false;
  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  if (req.headers['if-none-match'] === etag) { res.writeHead(304); res.end(); return true; }
  res.writeHead(200, {
    'Content-Type': mimeFor(file),
    'Content-Length': stat.size,
    'Cache-Control': maxAge ? `public, max-age=${maxAge}${immutable ? ', immutable' : ''}` : 'no-cache',
    ETag: etag,
  });
  if (req.method === 'HEAD') { res.end(); return true; }
  fs.createReadStream(file).pipe(res);
  return true;
}

export function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; " +
    "connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://checkout.stripe.com");
}
