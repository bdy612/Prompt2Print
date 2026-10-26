// Simple grid-based support columns.
//
// 1. Every downward-facing triangle steeper than the overhang limit (and not resting on the bed)
//    is rasterised onto an XY grid; each grid column remembers the Z of the overhang above it.
// 2. From each overhang, the column descends layer by layer through empty space until it reaches
//    the bed or the model (leaving one layer of Z gap on top and above the model).
// 3. Per layer, adjacent support columns in a grid row are joined into straight lines.
// Columns closer than `xyGap` to a wall (measured along the row) are skipped for that layer.

import { prepareEdges, scanIntervals, intervalLookup } from './geometry.js';

export function computeSupports({ pos, idx, outlines, tops, layerHeight, bbox, spacing = 2.5, xyGap = 0.7, maxAngleDeg = 45, bedZ = 0.3 }) {
  const nx = Math.max(1, Math.floor((bbox.maxX - bbox.minX) / spacing) + 1);
  const ny = Math.max(1, Math.floor((bbox.maxY - bbox.minY) / spacing) + 1);
  const x0 = bbox.minX + ((bbox.maxX - bbox.minX) - (nx - 1) * spacing) / 2;
  const y0 = bbox.minY + ((bbox.maxY - bbox.minY) - (ny - 1) * spacing) / 2;
  const colTops = new Map(); // column -> array of z
  const limit = Math.cos((maxAngleDeg * Math.PI) / 180);

  const nt = idx.length / 3;
  for (let t = 0; t < nt; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const ax = pos[a], ay = pos[a + 1], az = pos[a + 2];
    const bx = pos[b], by = pos[b + 1], bz = pos[b + 2];
    const cx = pos[c], cy = pos[c + 1], cz = pos[c + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nxr = uy * vz - uz * vy, nyr = uz * vx - ux * vz, nzr = ux * vy - uy * vx;
    const len = Math.hypot(nxr, nyr, nzr);
    if (len === 0) continue;
    if (-nzr / len <= limit) continue;
    if (Math.max(az, bz, cz) <= bedZ) continue;
    // rasterise onto grid
    const minX = Math.min(ax, bx, cx), maxX = Math.max(ax, bx, cx);
    const minY = Math.min(ay, by, cy), maxY = Math.max(ay, by, cy);
    const q0 = Math.max(0, Math.ceil((minX - x0) / spacing)), q1 = Math.min(nx - 1, Math.floor((maxX - x0) / spacing));
    const r0 = Math.max(0, Math.ceil((minY - y0) / spacing)), r1 = Math.min(ny - 1, Math.floor((maxY - y0) / spacing));
    if (q0 > q1 || r0 > r1) continue;
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(det) < 1e-12) continue;
    for (let r = r0; r <= r1; r++) {
      const py = y0 + r * spacing;
      for (let q = q0; q <= q1; q++) {
        const px = x0 + q * spacing;
        const l1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / det;
        const l2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / det;
        const l3 = 1 - l1 - l2;
        if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
        const z = l1 * az + l2 * bz + l3 * cz;
        if (z <= bedZ) continue;
        const col = r * nx + q;
        const arr = colTops.get(col);
        if (arr) arr.push(z); else colTops.set(col, [z]);
      }
    }
  }

  const L = tops.length;
  const support = Array.from({ length: L }, () => new Set());
  if (colTops.size === 0) return { layers: support.map(() => []), columns: 0 };

  const rowYs = Array.from({ length: ny }, (_, r) => y0 + r * spacing);
  const rowCache = new Map();
  const rows = (layer) => {
    let v = rowCache.get(layer);
    if (!v) { v = scanIntervals(prepareEdges(outlines[layer], 0), rowYs); rowCache.set(layer, v); }
    return v;
  };
  const layerAtOrBelow = (z) => {
    // highest layer index whose top <= z
    let lo = 0, hi = L - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (tops[m] <= z + 1e-6) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans;
  };

  for (const [col, zs] of colTops) {
    zs.sort((a, b) => b - a);
    const uniq = [];
    for (const z of zs) if (!uniq.length || uniq[uniq.length - 1] - z > layerHeight * 1.5) uniq.push(z);
    const r = Math.floor(col / nx), q = col % nx;
    const px = x0 + q * spacing;
    for (const zt of uniq) {
      let j = layerAtOrBelow(zt - layerHeight); // one layer of Z gap under the overhang
      let lastMarked = -1;
      for (; j >= 0; j--) {
        const iv = rows(j)[r];
        const hit = iv.length ? intervalLookup(iv, px) : { inside: false, dist: Infinity };
        if (hit.inside) {
          if (lastMarked === j + 1) support[j + 1].delete(col); // Z gap above the model
          break;
        }
        if (hit.dist < xyGap) continue;
        support[j].add(col);
        lastMarked = j;
      }
    }
  }

  // Convert to line segments per layer.
  const ext = Math.min(0.4, xyGap * 0.6);
  const layers = support.map((set) => {
    if (!set.size) return [];
    const byRow = new Map();
    for (const col of set) {
      const r = Math.floor(col / nx);
      const l = byRow.get(r);
      if (l) l.push(col % nx); else byRow.set(r, [col % nx]);
    }
    const segs = [];
    for (const [r, qs] of byRow) {
      qs.sort((a, b) => a - b);
      const y = y0 + r * spacing;
      let start = qs[0], prev = qs[0];
      for (let i = 1; i <= qs.length; i++) {
        if (i < qs.length && qs[i] === prev + 1) { prev = qs[i]; continue; }
        segs.push([x0 + start * spacing - ext, y, x0 + prev * spacing + ext, y]);
        if (i < qs.length) { start = qs[i]; prev = qs[i]; }
      }
    }
    return segs;
  });
  return { layers, columns: colTops.size };
}
