// Fetch wrapper for the Prompt2Print API.
export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `Request failed (${status})`);
    this.status = status;
    this.code = body?.error?.code;
    this.body = body;
  }
}

export async function api(path, { method = 'GET', body, raw, signal } = {}) {
  const headers = { 'X-P2P': '1' };
  let payload;
  if (raw) { payload = raw; headers['Content-Type'] = 'application/octet-stream'; }
  else if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  const res = await fetch(path, { method, headers, body: payload, signal, credentials: 'same-origin' });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const qs = (obj) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};
