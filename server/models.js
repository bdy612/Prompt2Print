// Model storage. Full-resolution models are kept in the private folder (never served).
// Each model gets an analysis (volume, area, size, watertightness, overhangs), a protected
// low-detail preview for the 3D viewer, and rendered PNG photos.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { get, run, parseJson } from './db.js';
import { writeBinarySTL, parseSTL } from './mesh/formats.js';
import { analyzeMesh } from './mesh/analyze.js';
import { buildPreview, encodePreview } from './mesh/preview.js';
import { renderPNG } from './mesh/render.js';
import { notFound } from './lib/http.js';
import { Worker } from 'node:worker_threads';

const previewsDir = path.join(config.dataDir, 'private', 'previews');
fs.mkdirSync(previewsDir, { recursive: true });

export function saveModel(mesh, { source, ownerUserId = null, preview = true } = {}) {
  const id = crypto.randomUUID();
  const fileName = `${id}.stl`;
  fs.writeFileSync(path.join(config.modelsDir, fileName), writeBinarySTL(mesh));
  const analysis = analyzeMesh(mesh);
  // The preview can also be built later, on first view (see previewBuffer).
  if (preview) fs.writeFileSync(path.join(previewsDir, `${id}.bin`), encodePreview(buildPreview(mesh)));
  run('INSERT INTO models(id, source, owner_user_id, file_name, analysis) VALUES(?, ?, ?, ?, ?)',
    [id, source, ownerUserId, fileName, JSON.stringify(analysis)]);
  return { id, analysis };
}

// Process a raw mesh in a background thread (see mesh/model-worker.js).
export function processModel(mesh, { repair = false, sizeMm = null, maxMm = null, thumb = null } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./mesh/model-worker.js', import.meta.url), {
      workerData: { positions: mesh.positions, indices: mesh.indices, repair, sizeMm, maxMm, thumb },
    });
    worker.once('message', (m) => (m.ok ? resolve(m) : reject(new Error(m.error))));
    worker.once('error', reject);
    worker.once('exit', (code) => { if (code !== 0) reject(new Error(`Model processing stopped (code ${code})`)); });
  });
}

// Store the output of processModel. Returns { id, analysis, thumbUrl }.
export function storeProcessedModel({ analysis, stl, preview, png }, { source, ownerUserId = null }) {
  const id = crypto.randomUUID();
  const fileName = `${id}.stl`;
  fs.writeFileSync(path.join(config.modelsDir, fileName), Buffer.from(stl));
  fs.writeFileSync(path.join(previewsDir, `${id}.bin`), Buffer.from(preview));
  run('INSERT INTO models(id, source, owner_user_id, file_name, analysis) VALUES(?, ?, ?, ?, ?)',
    [id, source, ownerUserId, fileName, JSON.stringify(analysis)]);
  let thumbUrl = null;
  if (png) {
    const media = `${id}-hero-thumb.png`;
    fs.writeFileSync(path.join(config.mediaDir, media), Buffer.from(png));
    thumbUrl = `/media/${media}`;
  }
  return { id, analysis, thumbUrl };
}

export function getModel(id) {
  const row = get('SELECT * FROM models WHERE id = ?', id);
  if (!row) return null;
  return { ...row, analysis: parseJson(row.analysis) };
}

export function loadMesh(id) {
  const row = getModel(id);
  if (!row) throw notFound('Model not found.');
  return parseSTL(fs.readFileSync(path.join(config.modelsDir, row.file_name)));
}

export function modelFilePath(id) {
  const row = getModel(id);
  if (!row) throw notFound('Model not found.');
  return path.join(config.modelsDir, row.file_name);
}

export function previewBuffer(id) {
  const file = path.join(previewsDir, `${id}.bin`);
  if (!fs.existsSync(file)) {
    const mesh = loadMesh(id);
    fs.writeFileSync(file, encodePreview(buildPreview(mesh)));
  }
  return fs.readFileSync(file);
}

/**
 * Render product photos for a model. Returns public URLs under /media.
 * views: ['hero', 'iso', 'front', 'top']
 */
export function renderPhotos(modelId, { color = '#D6246E', views = ['hero'], size = 640, mesh } = {}) {
  const m = mesh || loadMesh(modelId);
  const urls = [];
  const tag = color.replace('#', '').toLowerCase();
  for (const view of views) {
    const file = `${modelId}-${view}-${tag}-${size}.png`;
    const out = path.join(config.mediaDir, file);
    if (!fs.existsSync(out)) fs.writeFileSync(out, renderPNG(m, { width: size, height: size, color, view }));
    urls.push(`/media/${file}`);
  }
  return urls;
}
