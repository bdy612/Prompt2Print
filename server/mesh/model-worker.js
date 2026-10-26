// Heavy model processing in a background thread: repair, sizing, analysis, the private STL,
// the low-detail preview and the thumbnail photo. Keeps the shop responsive while AI models arrive.
import { parentPort, workerData } from 'node:worker_threads';
import { repairMesh, autoOrient } from './repair.js';
import { fitToSize, placeOnBed, computeBBox } from './core.js';
import { analyzeMesh } from './analyze.js';
import { writeBinarySTL } from './formats.js';
import { buildPreview, encodePreview } from './preview.js';
import { renderPNG } from './render.js';

try {
  const { positions, indices, repair, sizeMm, maxMm, thumb } = workerData;
  let mesh = { positions, indices };
  // AI-service models: fix holes and faces, then turn them to need the least support.
  mesh = repair ? autoOrient(repairMesh(mesh).mesh) : placeOnBed(mesh);
  if (sizeMm) mesh = placeOnBed(fitToSize(mesh, sizeMm));
  // Never larger than the printer limit (250 mm, with a little margin).
  if (maxMm && Math.max(...computeBBox(mesh).size) > maxMm) mesh = placeOnBed(fitToSize(mesh, maxMm));
  const analysis = analyzeMesh(mesh);
  const stl = writeBinarySTL(mesh);
  const preview = encodePreview(buildPreview(mesh));
  const png = thumb ? renderPNG(mesh, thumb) : null;
  parentPort.postMessage({ ok: true, analysis, stl, preview, png });
} catch (err) {
  parentPort.postMessage({ ok: false, error: err.message });
}
