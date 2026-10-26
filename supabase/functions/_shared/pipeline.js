// Model pipeline for the cloud: repair → orient → size → analyse → private STL + protected preview
// (+ optional rendered photo). Stages are separated by event-loop turns so the function's CPU
// watchdog sees short bursts rather than one long block.
import { parseAny, writeBinarySTL } from './mesh/formats.js';
import { repairMesh, autoOrient } from './mesh/repair.js';
import { fitToSize, placeOnBed, computeBBox, triangleCount } from './mesh/core.js';
import { analyzeMesh } from './mesh/analyze.js';
import { buildPreview, encodePreview } from './mesh/preview.js';
import { clusterSimplify } from './mesh/cluster.js';
import { renderPNG } from './mesh/render.js';
import { breathe } from './http.js';
import { putObject, mediaUrl } from './store.js';

/**
 * @param {object} input { mesh } or { bytes, hint }
 * @param {object} o { repair, sizeMm, maxMm = 250, photo: null | { color, width } }
 */
export async function processModel(input, o = {}) {
  let mesh = input.mesh || parseAny(input.bytes, input.hint || '.glb');
  await breathe();
  if (o.repair) { mesh = repairMesh(mesh).mesh; await breathe(); mesh = autoOrient(mesh); await breathe(); }
  else mesh = placeOnBed(mesh);
  if (o.sizeMm) mesh = placeOnBed(fitToSize(mesh, o.sizeMm));
  const maxMm = o.maxMm ?? 250;
  if (Math.max(...computeBBox(mesh).size) > maxMm) mesh = placeOnBed(fitToSize(mesh, maxMm));
  const analysis = analyzeMesh(mesh);
  await breathe();
  const stl = writeBinarySTL(mesh);
  // Preview: exact-ish quadric simplification for small meshes, fast clustering for big ones.
  const reduced = triangleCount(mesh) > 30000 ? clusterSimplify(mesh, { targetTriangles: 12000 }) : buildPreview(mesh);
  await breathe();
  const preview = encodePreview(reduced);
  let png = null;
  if (o.photo) { await breathe(); png = renderPNG(mesh, { width: o.photo.width || 480, height: o.photo.width || 480, view: 'hero', color: o.photo.color || '#1E1F22', supersample: o.photo.supersample || 1 }); }
  return { mesh, analysis, stl, preview, png };
}

/** Store the pipeline output: files in storage, row in models. Returns { id, analysis, thumbUrl }. */
export async function storeModel(db, out, { source, ownerId = null, thumbBytes = null, thumbExt = 'png' }) {
  const id = crypto.randomUUID();
  await putObject(db, 'models', `${id}.stl`, out.stl, 'application/octet-stream');
  await putObject(db, 'models', `${id}.p2pv`, out.preview, 'application/octet-stream');
  let thumbUrl = null;
  const thumb = thumbBytes || out.png;
  if (thumb) {
    const path = `models/${id}.${thumbExt}`;
    await putObject(db, 'media', path, thumb, thumbExt === 'png' ? 'image/png' : 'image/jpeg');
    thumbUrl = mediaUrl(path);
  }
  const { error } = await db.from('models').insert({ id, source, owner_id: ownerId, stl_path: `${id}.stl`, preview_path: `${id}.p2pv`, thumb_url: thumbUrl, analysis: out.analysis });
  if (error) throw new Error(error.message);
  return { id, analysis: out.analysis, thumbUrl };
}
