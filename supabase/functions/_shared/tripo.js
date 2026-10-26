// Tripo text-to-model (https://platform.tripo3d.ai). Keys come from the function's secrets.
const BASE = 'https://api.tripo3d.ai/v2/openapi';

export async function tripoCreate(apiKey, prompt, { faceLimit = 30000 } = {}) {
  const r = await fetch(`${BASE}/task`, {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'text_to_model', prompt: prompt.slice(0, 1000), negative_prompt: 'thin spikes, floating parts, separate pieces, low quality', face_limit: faceLimit }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.code !== 0) {
    const msg = body.message || body.suggestion || `HTTP ${r.status}`;
    const e = new Error(/credit|balance/i.test(msg) ? `Tripo account has no credits left (${msg})` : `Tripo refused the request: ${msg}`);
    e.tripo = true; e.noCredits = /credit|balance/i.test(msg);
    throw e;
  }
  return body.data.task_id;
}

export async function tripoStatus(apiKey, taskId) {
  const r = await fetch(`${BASE}/task/${encodeURIComponent(taskId)}`, { headers: { Authorization: `Bearer ${apiKey}` } });
  const body = await r.json().catch(() => ({}));
  const t = body.data || {};
  const out = t.output || {};
  return { status: t.status, progress: t.progress || 0, modelUrl: out.pbr_model || out.model || out.base_model || null, imageUrl: out.rendered_image || null };
}

export async function tripoBalance(apiKey) {
  const r = await fetch(`${BASE}/user/balance`, { headers: { Authorization: `Bearer ${apiKey}` } });
  const body = await r.json().catch(() => ({}));
  return body.code === 0 ? body.data : null;
}
