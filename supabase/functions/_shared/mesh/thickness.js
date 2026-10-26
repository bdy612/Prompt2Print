// Wall-thickness analysis. Rays are cast from random points on the surface straight into the
// model; the distance to the other side is the local thickness. The result is a set of quantiles
// at scale 1, so the thickness at any size the customer picks is just quantile × scale.

import { computeBBox, triNormalRaw } from './core.js';

function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Uniform grid of triangle indices for fast ray queries.
function buildGrid(mesh, bb, cellsPerAxis) {
  const size = bb.size.map((s) => Math.max(s, 1e-3));
  const cell = Math.max(...size) / cellsPerAxis;
  const dims = size.map((s) => Math.max(1, Math.ceil(s / cell)));
  const cells = new Map();
  const p = mesh.positions, ix = mesh.indices;
  for (let t = 0; t < ix.length / 3; t++) {
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let k = 0; k < 3; k++) {
      const v = ix[t * 3 + k] * 3;
      minX = Math.min(minX, p[v]); maxX = Math.max(maxX, p[v]);
      minY = Math.min(minY, p[v + 1]); maxY = Math.max(maxY, p[v + 1]);
      minZ = Math.min(minZ, p[v + 2]); maxZ = Math.max(maxZ, p[v + 2]);
    }
    const c0 = [minX, minY, minZ].map((v, k) => Math.min(dims[k] - 1, Math.max(0, Math.floor((v - bb.min[k]) / cell))));
    const c1 = [maxX, maxY, maxZ].map((v, k) => Math.min(dims[k] - 1, Math.max(0, Math.floor((v - bb.min[k]) / cell))));
    for (let x = c0[0]; x <= c1[0]; x++) {
      for (let y = c0[1]; y <= c1[1]; y++) {
        for (let z = c0[2]; z <= c1[2]; z++) {
          const key = (x * dims[1] + y) * dims[2] + z;
          let list = cells.get(key);
          if (!list) cells.set(key, (list = []));
          list.push(t);
        }
      }
    }
  }
  return { cells, cell, dims, min: bb.min };
}

// Möller–Trumbore ray/triangle intersection. Returns distance or -1.
function intersect(p, ix, t, ox, oy, oz, dx, dy, dz) {
  const a = ix[t * 3] * 3, b = ix[t * 3 + 1] * 3, c = ix[t * 3 + 2] * 3;
  const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2];
  const e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2];
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-12) return -1;
  const inv = 1 / det;
  const tx = ox - p[a], ty = oy - p[a + 1], tz = oz - p[a + 2];
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return -1;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return -1;
  return (e2x * qx + e2y * qy + e2z * qz) * inv;
}

// Walk the grid along the ray (3D DDA) and return the nearest hit beyond `minT`.
function castRay(grid, mesh, skipTri, ox, oy, oz, dx, dy, dz, maxT) {
  const { cells, cell, dims, min } = grid;
  const p = mesh.positions, ix = mesh.indices;
  let cx = Math.floor((ox - min[0]) / cell), cy = Math.floor((oy - min[1]) / cell), cz = Math.floor((oz - min[2]) / cell);
  cx = Math.min(dims[0] - 1, Math.max(0, cx)); cy = Math.min(dims[1] - 1, Math.max(0, cy)); cz = Math.min(dims[2] - 1, Math.max(0, cz));
  const step = [Math.sign(dx) || 1, Math.sign(dy) || 1, Math.sign(dz) || 1];
  const next = (c, o, d, k) => (d === 0 ? Infinity : ((min[k] + (c + (d > 0 ? 1 : 0)) * cell) - o) / d);
  let tMaxX = next(cx, ox, dx, 0), tMaxY = next(cy, oy, dy, 1), tMaxZ = next(cz, oz, dz, 2);
  const tDX = dx === 0 ? Infinity : cell / Math.abs(dx), tDY = dy === 0 ? Infinity : cell / Math.abs(dy), tDZ = dz === 0 ? Infinity : cell / Math.abs(dz);
  let best = Infinity;
  const seen = new Set();
  for (let guard = 0; guard < 4096; guard++) {
    const list = cells.get((cx * dims[1] + cy) * dims[2] + cz);
    if (list) {
      for (const t of list) {
        if (t === skipTri || seen.has(t)) continue;
        seen.add(t);
        const d = intersect(p, ix, t, ox, oy, oz, dx, dy, dz);
        if (d > 1e-4 && d < best) best = d;
      }
    }
    const cellExit = Math.min(tMaxX, tMaxY, tMaxZ);
    if (best <= cellExit || cellExit > maxT) break;
    if (tMaxX <= tMaxY && tMaxX <= tMaxZ) { cx += step[0]; tMaxX += tDX; if (cx < 0 || cx >= dims[0]) break; }
    else if (tMaxY <= tMaxZ) { cy += step[1]; tMaxY += tDY; if (cy < 0 || cy >= dims[1]) break; }
    else { cz += step[2]; tMaxZ += tDZ; if (cz < 0 || cz >= dims[2]) break; }
  }
  return best;
}

/**
 * Thickness quantiles at scale 1: { quantiles: [41 values for 0%, 2.5%, … 100%], samples }.
 * Each value is the local wall thickness in mm at that share of the surface.
 */
export function thicknessProfile(mesh, { samples = 1500, seed = 7 } = {}) {
  const p = mesh.positions, ix = mesh.indices;
  const nt = ix.length / 3;
  if (!nt) return { quantiles: new Array(41).fill(0), samples: 0 };
  const bb = computeBBox(mesh);
  const grid = buildGrid(mesh, bb, Math.min(80, Math.max(16, Math.round(Math.cbrt(nt) * 2))));
  // Area-weighted triangle choice.
  const cdf = new Float64Array(nt);
  let total = 0;
  for (let t = 0; t < nt; t++) {
    const n = triNormalRaw(p, ix[t * 3], ix[t * 3 + 1], ix[t * 3 + 2]);
    total += Math.hypot(n[0], n[1], n[2]) / 2;
    cdf[t] = total;
  }
  const rand = mulberry32(seed);
  const maxT = Math.max(...bb.size) * 2;
  const values = [];
  for (let s = 0; s < samples; s++) {
    const r = rand() * total;
    let lo = 0, hi = nt - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] < r) lo = mid + 1; else hi = mid; }
    const t = lo;
    let u = rand(), v = rand();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    const a = ix[t * 3] * 3, b = ix[t * 3 + 1] * 3, c = ix[t * 3 + 2] * 3;
    const ox = p[a] + u * (p[b] - p[a]) + v * (p[c] - p[a]);
    const oy = p[a + 1] + u * (p[b + 1] - p[a + 1]) + v * (p[c + 1] - p[a + 1]);
    const oz = p[a + 2] + u * (p[b + 2] - p[a + 2]) + v * (p[c + 2] - p[a + 2]);
    const n = triNormalRaw(p, ix[t * 3], ix[t * 3 + 1], ix[t * 3 + 2]);
    const len = Math.hypot(n[0], n[1], n[2]);
    if (!len) continue;
    const dx = -n[0] / len, dy = -n[1] / len, dz = -n[2] / len; // into the solid
    const d = castRay(grid, mesh, t, ox, oy, oz, dx, dy, dz, maxT);
    values.push(Number.isFinite(d) ? d : maxT);
  }
  values.sort((x, y) => x - y);
  const quantiles = [];
  for (let i = 0; i <= 40; i++) {
    const pos = (i / 40) * (values.length - 1);
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    quantiles.push(Math.round((values[lo] + (values[hi] - values[lo]) * (pos - lo)) * 1000) / 1000);
  }
  return { quantiles, samples: values.length };
}

// Share of the surface (0–1) thinner than `minMm` when printed at `scale`.
export function thinShare(profile, scale, minMm) {
  const q = profile?.quantiles;
  if (!q?.length) return 0;
  const limit = minMm / scale;
  if (q[0] >= limit) return 0;
  if (q[q.length - 1] < limit) return 1;
  for (let i = 1; i < q.length; i++) {
    if (q[i] >= limit) {
      const f = q[i] === q[i - 1] ? 0 : (limit - q[i - 1]) / (q[i] - q[i - 1]);
      return ((i - 1) + f) / (q.length - 1);
    }
  }
  return 1;
}

// Thickness (scale 1) at a given share of the surface, e.g. 0.03 → the thinnest 3%.
export function thicknessAt(profile, share) {
  const q = profile?.quantiles;
  if (!q?.length) return Infinity;
  const pos = Math.min(1, Math.max(0, share)) * (q.length - 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return q[lo] + (q[hi] - q[lo]) * (pos - lo);
}
