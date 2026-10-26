// Mesh → per-layer closed contours.
//
// For each slicing plane, every triangle that straddles it contributes one segment. Segments are
// oriented from the triangle edge that goes above→below to the edge that goes below→above, which
// (for an outward-facing CCW mesh) traces outer contours counter-clockwise and holes clockwise.
// Segment endpoints are keyed by the mesh edge they lie on, so chaining is exact for welded meshes;
// leftover open chains (triangle soup, small defects) are joined by coordinates as a fallback.

import { dedupePoints, polyArea, simplifyClosed, pointInPolygon, polyBBox, reversePoly } from './geometry.js';

export function sliceContours(pos /* Float64Array */, idx /* Uint32Array */, planes, opts = {}) {
  const closeGap = opts.closeGap ?? 0.8;
  const simplifyTol = opts.simplifyTol ?? 0.02;
  const nt = idx.length / 3;
  const nv = pos.length / 3;
  const tzmin = new Float64Array(nt), tzmax = new Float64Array(nt);
  for (let t = 0; t < nt; t++) {
    const za = pos[idx[t * 3] * 3 + 2], zb = pos[idx[t * 3 + 1] * 3 + 2], zc = pos[idx[t * 3 + 2] * 3 + 2];
    tzmin[t] = Math.min(za, zb, zc);
    tzmax[t] = Math.max(za, zb, zc);
  }
  const order = new Uint32Array(nt);
  for (let t = 0; t < nt; t++) order[t] = t;
  order.sort((a, b) => tzmin[a] - tzmin[b]);

  const layers = new Array(planes.length);
  let openChains = 0;
  let active = [];
  let ptr = 0;

  for (let li = 0; li < planes.length; li++) {
    const z = planes[li];
    while (ptr < nt && tzmin[order[ptr]] <= z) active.push(order[ptr++]);
    let w = 0;
    for (let r = 0; r < active.length; r++) { const t = active[r]; if (tzmax[t] >= z) active[w++] = t; }
    active.length = w;

    // Build segments.
    const startMap = new Map(); // startKey -> [segment indices]
    const segs = []; // {sk, ek, sx, sy, ex, ey}
    for (let r = 0; r < active.length; r++) {
      const t = active[r];
      const v = [idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]];
      const above = [pos[v[0] * 3 + 2] >= z, pos[v[1] * 3 + 2] >= z, pos[v[2] * 3 + 2] >= z];
      const nAbove = above[0] + above[1] + above[2];
      if (nAbove === 0 || nAbove === 3) continue;
      let sk = -1, ek = -1, sx = 0, sy = 0, ex = 0, ey = 0;
      for (let e = 0; e < 3; e++) {
        const u = v[e], w2 = v[(e + 1) % 3];
        const au = above[e], aw = above[(e + 1) % 3];
        if (au === aw) continue;
        const lo = au ? w2 : u; // the vertex below the plane
        const hi = au ? u : w2;
        const zl = pos[lo * 3 + 2], zh = pos[hi * 3 + 2];
        const tt = (z - zl) / (zh - zl);
        const x = pos[lo * 3] + tt * (pos[hi * 3] - pos[lo * 3]);
        const y = pos[lo * 3 + 1] + tt * (pos[hi * 3 + 1] - pos[lo * 3 + 1]);
        const key = lo * nv + hi;
        if (au && !aw) { sk = key; sx = x; sy = y; } // above → below: segment start
        else { ek = key; ex = x; ey = y; }           // below → above: segment end
      }
      if (sk < 0 || ek < 0) continue;
      const si = segs.length;
      segs.push({ sk, ek, sx, sy, ex, ey });
      const list = startMap.get(sk);
      if (list) list.push(si); else startMap.set(sk, [si]);
    }

    // Chain by edge keys.
    const used = new Uint8Array(segs.length);
    const loops = [];
    const open = [];
    for (let s0 = 0; s0 < segs.length; s0++) {
      if (used[s0]) continue;
      used[s0] = 1;
      const pts = [segs[s0].sx, segs[s0].sy];
      const firstKey = segs[s0].sk;
      let cur = segs[s0];
      let closed = false;
      for (let guard = 0; guard < segs.length + 1; guard++) {
        pts.push(cur.ex, cur.ey);
        if (cur.ek === firstKey) { closed = true; break; }
        const cands = startMap.get(cur.ek);
        let next = -1;
        if (cands) for (const c of cands) if (!used[c]) { next = c; break; }
        if (next < 0) break;
        used[next] = 1;
        cur = segs[next];
      }
      if (closed) { pts.length -= 2; loops.push(pts); } // last point equals the first
      else open.push(pts);
    }

    // Fallback: join open chains by coordinates.
    if (open.length) {
      const joined = joinOpenChains(open, closeGap);
      for (const l of joined.loops) loops.push(l);
      openChains += joined.dropped;
    }

    // Clean up.
    const clean = [];
    for (const l of loops) {
      let p = dedupePoints(l);
      if (p.length < 6) continue;
      p = simplifyClosed(p, simplifyTol);
      if (p.length < 6) continue;
      if (Math.abs(polyArea(p)) < 0.01) continue;
      clean.push(Float64Array.from(p));
    }
    layers[li] = clean;
  }
  return { layers, openChains };
}

function joinOpenChains(chains, closeGap) {
  const q = (v) => Math.round(v * 1e4);
  const key = (x, y) => `${q(x)},${q(y)}`;
  const byStart = new Map();
  chains.forEach((c, i) => {
    const k = key(c[0], c[1]);
    const l = byStart.get(k);
    if (l) l.push(i); else byStart.set(k, [i]);
  });
  const used = new Uint8Array(chains.length);
  const loops = [];
  let dropped = 0;
  for (let i = 0; i < chains.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const pts = chains[i].slice();
    const sk = key(pts[0], pts[1]);
    let closed = false;
    for (let guard = 0; guard < chains.length + 1; guard++) {
      const ek = key(pts[pts.length - 2], pts[pts.length - 1]);
      if (ek === sk && pts.length > 4) { closed = true; pts.length -= 2; break; }
      const cands = byStart.get(ek);
      let next = -1;
      if (cands) for (const c of cands) if (!used[c]) { next = c; break; }
      if (next < 0) break;
      used[next] = 1;
      const nc = chains[next];
      for (let k = 2; k < nc.length; k++) pts.push(nc[k]);
    }
    if (!closed) {
      const gap = Math.hypot(pts[0] - pts[pts.length - 2], pts[1] - pts[pts.length - 1]);
      if (gap <= closeGap && pts.length >= 6) closed = true;
    }
    if (closed) loops.push(pts); else dropped++;
  }
  return { loops, dropped };
}

/**
 * Group the loops of one layer into islands using even-odd nesting depth.
 * Outer contours (even depth) are forced CCW, holes (odd depth) CW, so the material is always on
 * the left of the direction of travel. Returns { islands: [{ outer, holes: [] }], outlines: [...] }.
 */
export function buildIslands(loops) {
  const n = loops.length;
  const info = loops.map((p) => ({ p, area: Math.abs(polyArea(p)), bb: polyBBox(p), depth: 0, parent: -1 }));
  for (let i = 0; i < n; i++) {
    const x = info[i].p[0], y = info[i].p[1];
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const bb = info[j].bb;
      if (x < bb.minX || x > bb.maxX || y < bb.minY || y > bb.maxY) continue;
      if (info[j].area <= info[i].area) continue;
      if (pointInPolygon(x, y, info[j].p)) {
        info[i].depth++;
        if (info[i].parent < 0 || info[j].area < info[info[i].parent].area) info[i].parent = j;
      }
    }
  }
  const outlines = [];
  const islands = [];
  const islandOf = new Map();
  for (let i = 0; i < n; i++) {
    const it = info[i];
    const ccw = polyArea(it.p) > 0;
    const wantCCW = it.depth % 2 === 0;
    it.p = ccw === wantCCW ? it.p : reversePoly(it.p);
    outlines.push(it.p);
  }
  for (let i = 0; i < n; i++) {
    if (info[i].depth % 2 === 0) {
      islandOf.set(i, islands.length);
      islands.push({ outer: info[i].p, holes: [], area: info[i].area });
    }
  }
  for (let i = 0; i < n; i++) {
    if (info[i].depth % 2 === 1 && info[i].parent >= 0) {
      const isl = islandOf.get(info[i].parent);
      if (isl !== undefined) islands[isl].holes.push(info[i].p);
    }
  }
  return { islands, outlines };
}
