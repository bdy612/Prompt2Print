// Tiny Supabase client for the print agent: PostgREST (tables) and Storage (model files) over fetch.
// No npm dependencies. All calls use the service-role key, which must stay on the owner's PC.

export class RestError extends Error {
  constructor(message, status, body) { super(message); this.status = status; this.body = body; }
}

/** Build the query string PostgREST expects: { select, filters: [[col, op, value]], order, limit } */
export function buildQuery({ select, filters = [], order, limit, offset } = {}) {
  const p = new URLSearchParams();
  if (select) p.set('select', select);
  for (const [col, op, value] of filters) {
    if (op === 'in') p.append(col, `in.(${value.map((v) => encodeValue(v)).join(',')})`);
    else if (op === 'is') p.append(col, `is.${value}`);
    else p.append(col, `${op}.${value}`);
  }
  if (order) p.set('order', order);
  if (limit !== undefined) p.set('limit', String(limit));
  if (offset !== undefined) p.set('offset', String(offset));
  const q = p.toString();
  return q ? `?${q}` : '';
}

function encodeValue(v) {
  const s = String(v);
  return /[,()." ]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

export function createRest({ url, serviceRoleKey, fetchImpl = globalThis.fetch }) {
  const base = String(url).replace(/\/+$/, '');
  const headers = (extra = {}) => ({ apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, ...extra });

  async function request(method, path, { body, extra = {}, raw = false, timeoutMs = 30000 } = {}) {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: headers(body !== undefined ? { 'Content-Type': 'application/json', ...extra } : extra),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new RestError(`${method} ${path} → HTTP ${res.status} ${text.slice(0, 300)}`, res.status, text);
    }
    if (raw) return res;
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  return {
    /** SELECT rows. */
    select(table, opts) { return request('GET', `/rest/v1/${table}${buildQuery(opts)}`); },
    /** SELECT one row or null. */
    async one(table, opts) { const rows = await this.select(table, { ...opts, limit: 1 }); return rows?.[0] ?? null; },
    /** INSERT rows; returns the inserted rows. */
    insert(table, rows) {
      return request('POST', `/rest/v1/${table}`, { body: rows, extra: { Prefer: 'return=representation' } });
    },
    /** UPDATE matching rows; returns them. */
    update(table, filters, patch) {
      return request('PATCH', `/rest/v1/${table}${buildQuery({ filters })}`, { body: patch, extra: { Prefer: 'return=representation' } });
    },
    /** DELETE matching rows. */
    remove(table, filters) { return request('DELETE', `/rest/v1/${table}${buildQuery({ filters })}`); },
    /** Download an object from a private bucket as a Buffer. */
    async download(bucket, objectPath) {
      const res = await request('GET', `/storage/v1/object/${bucket}/${objectPath.split('/').map(encodeURIComponent).join('/')}`, { raw: true, timeoutMs: 120000 });
      return Buffer.from(await res.arrayBuffer());
    },
    /** Upload (upsert) an object into a bucket. */
    async upload(bucket, objectPath, data, contentType = 'application/octet-stream') {
      const res = await fetchImpl(`${base}/storage/v1/object/${bucket}/${objectPath.split('/').map(encodeURIComponent).join('/')}`, {
        method: 'POST', headers: headers({ 'Content-Type': contentType, 'x-upsert': 'true' }), body: data, signal: AbortSignal.timeout(120000),
      });
      if (!res.ok) throw new RestError(`upload ${objectPath} → HTTP ${res.status}`, res.status, await res.text().catch(() => ''));
      return true;
    },
  };
}
