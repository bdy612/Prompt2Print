// Small helpers shared by the edge functions: JSON responses, CORS, auth, service client.
import { createClient } from 'npm:@supabase/supabase-js@2';

export class HttpError extends Error {
  constructor(status, message, code = 'error') { super(message); this.status = status; this.code = code; }
}
export const bad = (message, code) => new HttpError(400, message, code);
export const unauthorized = (message = 'Sign in first.') => new HttpError(401, message, 'unauthorized');
export const forbidden = (message = 'Not allowed.') => new HttpError(403, message, 'forbidden');
export const notFound = (message = 'Not found.') => new HttpError(404, message, 'not_found');

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

export function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS, ...extra } });
}

/** Wrap a handler: CORS preflight, JSON body parsing, uniform error responses. */
export function serve(handler) {
  Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
    try {
      let body = {};
      if (req.method === 'POST') {
        const text = await req.text();
        if (text) { try { body = JSON.parse(text); } catch { throw bad('Invalid JSON body.', 'bad_json'); } }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('Invalid request body.', 'bad_json');
      }
      const out = await handler(req, body);
      return out instanceof Response ? out : json(out ?? { ok: true });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      return json({ error: { message: status === 500 ? 'Something went wrong on our side.' : err.message, code: err.code || 'error' } }, status);
    }
  });
}

export const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');

/** Service-role client: bypasses RLS. Use only inside functions, never hand it to clients. */
export function serviceClient() {
  return createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** The signed-in user (from the request's Authorization header) with their profile, or null. */
export async function currentUser(req) {
  const auth = req.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token || token === ANON_KEY) return null;
  const db = serviceClient();
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) return null;
  const { data: profile } = await db.from('profiles').select('*').eq('id', data.user.id).maybeSingle();
  if (!profile || profile.disabled) return null;
  return { id: data.user.id, email: profile.email, name: profile.name, role: profile.role, locale: profile.locale };
}

export async function requireUser(req) {
  const u = await currentUser(req);
  if (!u) throw unauthorized();
  return u;
}
export async function requireAdmin(req) {
  const u = await requireUser(req);
  if (u.role !== 'admin') throw forbidden();
  return u;
}

export function clientIp(req) {
  return (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || req.headers.get('cf-connecting-ip') || '';
}

export async function audit(db, req, user, action, detail = {}) {
  await db.from('audit_log').insert({ user_id: user?.id || null, email: user?.email || null, action, detail, ip: clientIp(req) }).then(() => {}, () => {});
}

/** Give the event loop a turn between heavy synchronous stages (keeps the CPU watchdog happy). */
export const breathe = () => new Promise((r) => setTimeout(r, 0));
