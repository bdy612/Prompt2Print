// Fast mesh reduction by vertex clustering (uniform grid). O(n), used for the protected previews of
// large AI models where quadric simplification would be too slow for an edge function.
import { computeBBox } from './core.js';

export function clusterSimplify(mesh, { targetTriangles = 12000 } = {}) {
  const { positions: p, indices: ix } = mesh;
  const nt = ix.length / 3;
  if (nt <= targetTriangles) return mesh;
  const bb = computeBBox(mesh);
  const size = Math.max(...bb.size, 1e-6);
  // cells per axis so that roughly targetTriangles survive (surface ~ cells^2)
  let cells = Math.max(8, Math.round(Math.sqrt(targetTriangles / 2)));
  for (let attempt = 0; attempt < 4; attempt++) {
    const cell = size / cells;
    const map = new Map();
    const remap = new Int32Array(p.length / 3);
    const sums = [];
    for (let v = 0; v < p.length / 3; v++) {
      const gx = Math.floor((p[v * 3] - bb.min[0]) / cell), gy = Math.floor((p[v * 3 + 1] - bb.min[1]) / cell), gz = Math.floor((p[v * 3 + 2] - bb.min[2]) / cell);
      const key = ((gx * 73856093) ^ (gy * 19349663) ^ (gz * 83492791)) + ':' + gx + ',' + gy + ',' + gz;
      let id = map.get(key);
      if (id === undefined) { id = sums.length; map.set(key, id); sums.push([0, 0, 0, 0]); }
      const s = sums[id]; s[0] += p[v * 3]; s[1] += p[v * 3 + 1]; s[2] += p[v * 3 + 2]; s[3] += 1;
      remap[v] = id;
    }
    const out = [];
    for (let t = 0; t < ix.length; t += 3) {
      const a = remap[ix[t]], b = remap[ix[t + 1]], c = remap[ix[t + 2]];
      if (a !== b && b !== c && a !== c) out.push(a, b, c);
    }
    if (out.length / 3 <= targetTriangles * 1.3 || attempt === 3) {
      const positions = new Float32Array(sums.length * 3);
      sums.forEach((s, i) => { positions[i * 3] = s[0] / s[3]; positions[i * 3 + 1] = s[1] / s[3]; positions[i * 3 + 2] = s[2] / s[3]; });
      return { positions, indices: Uint32Array.from(out) };
    }
    cells = Math.max(8, Math.round(cells * Math.sqrt(targetTriangles / (out.length / 3)) * 0.95));
  }
  return mesh;
}
