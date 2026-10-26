// Text-to-3D providers. Each provider turns a prompt into a raw mesh on the server.
//   demo  – built-in offline generator (no account needed; shapes from keywords)
//   meshy – Meshy API (https://docs.meshy.ai) text-to-3d "preview" (untextured geometry)
//   tripo – Tripo API (https://developers.tripo3d.com) text-to-model
// Downloaded model files are parsed in memory and stored only in the private models folder.

import { getSetting } from '../db.js';
import { decryptSecret } from '../lib/secrets.js';
import { generateFromPrompt } from './procedural.js';
import { parseAny } from '../mesh/formats.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function key(name, envName) {
  return decryptSecret(getSetting(name, '')) || process.env[envName] || '';
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Model download failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

export const providers = {
  demo: {
    id: 'demo',
    label: 'Built-in generator (no AI service)',
    configured: () => true,
    async generate({ prompt, seed, onProgress }) {
      onProgress?.(30);
      await sleep(900); // let the UI show the "generating" state
      const { mesh, info } = generateFromPrompt(prompt, { seed });
      onProgress?.(90);
      return { mesh, titleEn: info.titleEn, titleAr: info.titleAr, realSize: true };
    },
  },

  meshy: {
    id: 'meshy',
    label: 'Meshy',
    configured: () => Boolean(key('meshy_api_key', 'MESHY_API_KEY')),
    async generate({ prompt, onProgress, onTask }) {
      const apiKey = key('meshy_api_key', 'MESHY_API_KEY');
      if (!apiKey) throw new Error('Meshy API key is not set (Admin → Integrations).');
      const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
      const create = await fetch('https://api.meshy.ai/openapi/v2/text-to-3d', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          mode: 'preview',
          prompt: prompt.slice(0, 800),
          ai_model: 'latest',
          topology: 'triangle',
          should_remesh: true,
          target_polycount: 60000,
          target_formats: ['stl', 'glb'],
          origin_at: 'bottom',
          moderation: true,
        }),
      });
      const created = await create.json().catch(() => ({}));
      if (!create.ok) throw new Error(`Meshy refused the request (${create.status}): ${created.message || 'unknown error'}`);
      const taskId = created.result;
      onTask?.(taskId);
      const deadline = Date.now() + 15 * 60e3;
      while (Date.now() < deadline) {
        await sleep(4000);
        const r = await fetch(`https://api.meshy.ai/openapi/v2/text-to-3d/${encodeURIComponent(taskId)}`, { headers });
        const task = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(`Meshy status check failed (${r.status})`);
        onProgress?.(Math.min(95, task.progress || 0));
        if (task.status === 'SUCCEEDED') {
          const url = task.model_urls?.stl || task.model_urls?.glb || task.model_urls?.obj;
          if (!url) throw new Error('Meshy finished without a model file');
          const fmt = task.model_urls?.stl ? '.stl' : task.model_urls?.glb ? '.glb' : '.obj';
          return { mesh: parseAny(await download(url), fmt) };
        }
        if (task.status === 'FAILED' || task.status === 'CANCELED') {
          throw new Error(`Meshy could not generate this model: ${task.task_error?.message || task.status}`);
        }
      }
      throw new Error('Meshy took too long to respond');
    },
  },

  tripo: {
    id: 'tripo',
    label: 'Tripo',
    configured: () => Boolean(key('tripo_api_key', 'TRIPO_API_KEY')),
    async generate({ prompt, onProgress, onTask }) {
      const apiKey = key('tripo_api_key', 'TRIPO_API_KEY');
      if (!apiKey) throw new Error('Tripo API key is not set (Admin → Integrations).');
      const base = getSetting('tripo_base_url', '') || 'https://api.tripo3d.ai/v2/openapi';
      const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
      const create = await fetch(`${base}/task`, {
        method: 'POST', headers,
        body: JSON.stringify({ type: 'text_to_model', prompt: prompt.slice(0, 1000), negative_prompt: 'thin spikes, floating parts, separate pieces, low quality' }),
      });
      const created = await create.json().catch(() => ({}));
      if (!create.ok || created.code !== 0) {
        const msg = created.message || created.suggestion || 'unknown error';
        throw new Error(/credit|balance/i.test(msg) ? `Tripo account has no credits left (${msg})` : `Tripo refused the request (${create.status}): ${msg}`);
      }
      const taskId = created.data?.task_id;
      onTask?.(taskId);
      const deadline = Date.now() + 15 * 60e3;
      while (Date.now() < deadline) {
        await sleep(3000);
        const r = await fetch(`${base}/task/${encodeURIComponent(taskId)}`, { headers });
        const body = await r.json().catch(() => ({}));
        const task = body.data || {};
        onProgress?.(Math.min(95, task.progress || 0));
        if (task.status === 'success') {
          const out = task.output || {};
          const url = out.pbr_model || out.model || out.base_model || task.model_url;
          if (!url) throw new Error('Tripo finished without a model file');
          return { mesh: parseAny(await download(url), '.glb') }; // URLs expire after a few minutes
        }
        if (['failed', 'cancelled', 'banned', 'expired', 'unknown'].includes(task.status)) {
          throw new Error(`Tripo could not generate this model (${task.status})`);
        }
      }
      throw new Error('Tripo took too long to respond');
    },
  },
};

// 'auto' = the first AI service with a key (Meshy, then Tripo); the built-in generator otherwise.
export function activeProvider() {
  const chosen = getSetting('ai_provider', process.env.AI_PROVIDER || 'auto');
  if (chosen === 'auto') return providers.meshy.configured() ? providers.meshy : providers.tripo.configured() ? providers.tripo : providers.demo;
  const p = providers[chosen];
  return p && p.configured() ? p : providers.demo;
}
