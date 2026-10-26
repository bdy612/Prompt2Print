// Geometry builders for the offline demo generator.
// Every primitive below adds one closed, watertight, outward-facing part to a Builder.
// Parts never share vertices, so overlapping parts stay individually manifold.

import { signedVolume } from '../../mesh/core.js';

export const TAU = Math.PI * 2;

// ---------- small vector helpers ----------
export const vadd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const vscale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const vcross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const vlen = (a) => Math.hypot(a[0], a[1], a[2]);
export const vnorm = (a) => { const l = vlen(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// ---------- builder ----------
export class Builder {
  constructor() {
    this.pos = [];
    this.idx = [];
    this._partStart = null;
  }
  get vcount() { return this.pos.length / 3; }
  v(x, y, z) { this.pos.push(x, y, z); return this.pos.length / 3 - 1; }
  tri(a, b, c) { this.idx.push(a, b, c); }

  begin() { this._partStart = { v: this.vcount, i: this.idx.length }; }

  // Closes a part: applies an optional transform to its vertices and makes sure it faces outward.
  end(transform) {
    const s = this._partStart;
    this._partStart = null;
    if (transform) {
      for (let k = s.v; k < this.vcount; k++) {
        const r = transform(this.pos[k * 3], this.pos[k * 3 + 1], this.pos[k * 3 + 2]);
        this.pos[k * 3] = r[0]; this.pos[k * 3 + 1] = r[1]; this.pos[k * 3 + 2] = r[2];
      }
    }
    // Self-heal orientation: a closed part with negative volume is inside out.
    const part = { positions: this.pos, indices: this.idx.slice(s.i) };
    if (signedVolume(part) < 0) {
      for (let t = s.i; t < this.idx.length; t += 3) {
        const tmp = this.idx[t + 1]; this.idx[t + 1] = this.idx[t + 2]; this.idx[t + 2] = tmp;
      }
    }
    return this;
  }

  toMesh() {
    return { positions: Float32Array.from(this.pos), indices: Uint32Array.from(this.idx) };
  }
}

// ---------- transforms (orientation-preserving) ----------
export const xf = {
  translate: (dx, dy, dz) => (x, y, z) => [x + dx, y + dy, z + dz],
  scale: (s) => (x, y, z) => [x * s, y * s, z * s],
  rotZ: (a) => { const c = Math.cos(a), s = Math.sin(a); return (x, y, z) => [x * c - y * s, x * s + y * c, z]; },
  rotX: (a) => { const c = Math.cos(a), s = Math.sin(a); return (x, y, z) => [x, y * c - z * s, y * s + z * c]; },
  compose: (...fns) => (x, y, z) => fns.reduce((p, f) => f(p[0], p[1], p[2]), [x, y, z]),
};

// ---------- cross-section functions s(theta, z) ----------
const frac = (x) => x - Math.floor(x + 1e-7);
const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

export const sections = {
  round: () => 1,
  // Regular n-gon with circumradius 1 (flat sides). Use a segment count that is a multiple of n.
  polygon: (n, phase = 0) => (th) => {
    const seg = TAU / n;
    const local = ((((th - phase) % seg) + seg) % seg) - seg / 2;
    return Math.cos(Math.PI / n) / Math.cos(local);
  },
  // Star with rounded points and valleys (no sharp vertical edges).
  star: (n, depth) => (th) => { const t = frac((th * n) / TAU); const tri = 1 - Math.abs(2 * t - 1); return 1 - depth * smooth(0, 1, tri); },
  // Regular n-gon with rounded corners (p controls the corner radius; ~8–14 is a soft corner).
  roundedPolygon: (n, p = 10, phase = 0) => (th) => {
    let sum = 0;
    for (let k = 0; k < n; k++) { const c = Math.cos(th - phase - (TAU * k) / n); if (c > 0) sum += Math.pow(c, p); }
    return Math.pow(sum, -1 / p);
  },
  // Soft petals.
  flower: (n, depth) => (th) => 1 - depth * (0.5 - 0.5 * Math.cos(n * th)),
  wavy: (n, amp) => (th) => (1 + amp * Math.cos(n * th)) / (1 + amp),
  gear: (n, depth) => (th) => {
    const t = frac((th * n) / TAU);
    const tooth = smooth(0.12, 0.22, t) - smooth(0.62, 0.72, t);
    return 1 - depth * (1 - tooth);
  },
  // Rounded rectangle with half-sizes a, b (mm). Use with profile r = 1.
  superellipse: (a, b, p = 5) => (th) => {
    const c = Math.abs(Math.cos(th)) / a, s = Math.abs(Math.sin(th)) / b;
    return Math.pow(Math.pow(c, p) + Math.pow(s, p), -1 / p);
  },
  // Diamond "scales" pattern that wraps around and up (dragon skin).
  scales: (n, rowH, amp) => (th, z) => {
    const u = (n * th) / 2, v = (Math.PI * z) / rowH;
    return 1 - amp + amp * 0.5 * (Math.abs(Math.sin(u + v)) + Math.abs(Math.sin(u - v)));
  },
};

// ---------- lathe ----------
// profile: [{ r, z, inset?, section?, lift? }], from the axis at the bottom (r = 0) to the axis at the top,
// or a closed loop that never touches the axis (first and last r > 0).
// Outward normals need the profile to run bottom → outside → top (like a sphere's outline drawn counter-clockwise).
// Radial inset that gives a wall of thickness `wall` measured along the surface normal, for a
// surface r(θ, z) = R(z)·sec(θ, z) twisted by tw(z). Numerical, so it handles ribs, facets and twists.
export function wallInset(wall, th, p, opts) {
  const section = p.section ?? opts.section ?? sections.round;
  const twist = opts.twist ?? (() => 0);
  const R = opts.outerR ? opts.outerR : () => p.r;
  const S = (t, z) => { const r = R(z) * section(t, z); const a = t + twist(z); return [r * Math.cos(a), r * Math.sin(a), z]; };
  const h = 1e-3, hz = 0.05;
  const A = S(th + h, p.z), B = S(th - h, p.z), C = S(th, p.z + hz), D = S(th, p.z - hz);
  const St = vsub(A, B), Sz = vsub(C, D);
  const n = vnorm(vcross(St, Sz));
  const a = th + twist(p.z);
  const factor = Math.abs(n[0] * Math.cos(a) + n[1] * Math.sin(a));
  return wall / Math.max(0.42, factor);
}

export function lathe(b, profile, opts = {}) {
  const N = opts.segments ?? 96;
  const section = opts.section ?? sections.round;
  const twist = opts.twist ?? (() => 0);
  const lift = opts.lift ?? (() => 0);
  const minR = opts.minR ?? 0.3;
  const phase = opts.phase ?? 0;
  b.begin();
  const rings = [];
  for (const p of profile) {
    if (p.r <= 0) { rings.push({ pole: b.v(0, 0, p.z + (p.lift ? lift(0, p) : 0)) }); continue; }
    const ids = new Array(N);
    const tw = twist(p.z) + phase;
    const sec = p.section ?? section;
    for (let j = 0; j < N; j++) {
      const th = (TAU * j) / N;
      const inset = p.wall !== undefined ? wallInset(p.wall, th, p, opts) + (p.inset ?? 0) : (p.inset ?? 0);
      const r = Math.max(minR, p.r * sec(th, p.z) - inset);
      const z = p.z + (p.lift ? lift(th, p) : 0);
      const a = th + tw;
      ids[j] = b.v(r * Math.cos(a), r * Math.sin(a), z);
    }
    rings.push({ ring: ids });
  }
  const connect = (A, B) => {
    if (A.pole !== undefined && B.pole !== undefined) throw new Error('lathe: two poles in a row');
    for (let j = 0; j < N; j++) {
      const j1 = (j + 1) % N;
      if (A.pole !== undefined) b.tri(A.pole, B.ring[j1], B.ring[j]);
      else if (B.pole !== undefined) b.tri(A.ring[j], A.ring[j1], B.pole);
      else {
        b.tri(A.ring[j], A.ring[j1], B.ring[j1]);
        b.tri(A.ring[j], B.ring[j1], B.ring[j]);
      }
    }
  };
  for (let i = 0; i < rings.length - 1; i++) connect(rings[i], rings[i + 1]);
  const closedLoop = profile[0].r > 0 && profile[profile.length - 1].r > 0;
  if (closedLoop) connect(rings[rings.length - 1], rings[0]);
  b.end(opts.transform);
}

// Exact radius of a lathe ring (including its flat facets) at world angle `theta`.
export function ringRadiusAt(p, theta, opts = {}) {
  const N = opts.segments ?? 96;
  const section = p.section ?? opts.section ?? sections.round;
  const twist = opts.twist ?? (() => 0);
  const minR = opts.minR ?? 0.3;
  const base = theta - twist(p.z) - (opts.phase ?? 0);
  const step = TAU / N;
  const j0 = Math.floor(base / step);
  const a0 = j0 * step, a1 = (j0 + 1) * step;
  const rad = (a) => Math.max(minR, p.r * section(((a % TAU) + TAU) % TAU, p.z) - (p.inset ?? 0));
  const r0 = rad(a0), r1 = rad(a1);
  const P0 = [r0 * Math.cos(a0), r0 * Math.sin(a0)], P1 = [r1 * Math.cos(a1), r1 * Math.sin(a1)];
  const d = [Math.cos(base), Math.sin(base)];
  const cr = (u, w) => u[0] * w[1] - u[1] * w[0];
  const c0 = cr(P0, d), c1 = cr(P1, d);
  const t = c0 / (c0 - c1 || 1e-12);
  return Math.hypot(P0[0] + t * (P1[0] - P0[0]), P0[1] + t * (P1[1] - P0[1]));
}

// ---------- loft ----------
// rings: arrays of [x,y,z] points with the same count, each ordered counter-clockwise when viewed from
// the direction the rings advance towards. Caps are fans to the ring centroid or to a given point.
export function loft(b, rings, { startCap = 'centroid', endCap = 'centroid', closed = false, transform } = {}) {
  b.begin();
  const M = rings[0].length;
  const ids = rings.map((ring) => ring.map((p) => b.v(p[0], p[1], p[2])));
  const connect = (A, B) => {
    for (let j = 0; j < M; j++) {
      const j1 = (j + 1) % M;
      b.tri(A[j], A[j1], B[j1]);
      b.tri(A[j], B[j1], B[j]);
    }
  };
  for (let i = 0; i < ids.length - 1; i++) connect(ids[i], ids[i + 1]);
  if (closed) connect(ids[ids.length - 1], ids[0]);
  else {
    const c0 = startCap === 'centroid' ? centroid(rings[0]) : startCap;
    const s = b.v(c0[0], c0[1], c0[2]);
    for (let j = 0; j < M; j++) b.tri(s, ids[0][(j + 1) % M], ids[0][j]);
    const last = rings[rings.length - 1];
    const c1 = endCap === 'centroid' ? centroid(last) : endCap;
    const e = b.v(c1[0], c1[1], c1[2]);
    const L = ids[ids.length - 1];
    for (let j = 0; j < M; j++) b.tri(L[j], L[(j + 1) % M], e);
  }
  b.end(transform);
}

export function centroid(pts) {
  const c = [0, 0, 0];
  for (const p of pts) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
  return vscale(c, 1 / pts.length);
}

// Rings for a tube swept along a planar path. `binormal` is the normal of the path's plane.
// sectionAt(i, t) returns [[u, v], ...] counter-clockwise; point = P + u·N + v·B with N = B × T.
export function sweepRings(path, sectionAt, binormal, closed = false) {
  const n = path.length;
  const rings = [];
  for (let i = 0; i < n; i++) {
    let prev, next;
    if (closed) { prev = path[(i - 1 + n) % n]; next = path[(i + 1) % n]; }
    else { prev = path[Math.max(0, i - 1)]; next = path[Math.min(n - 1, i + 1)]; }
    const T = vnorm(vsub(next, prev));
    const N = vnorm(vcross(binormal, T));
    const B = vcross(T, N);
    const sec = sectionAt(i, n === 1 ? 0 : i / (n - 1));
    rings.push(sec.map(([u, v]) => vadd(path[i], vadd(vscale(N, u), vscale(B, v)))));
  }
  return rings;
}

export const circleSection = (a, bb = a, seg = 16) => {
  const pts = [];
  for (let k = 0; k < seg; k++) { const t = (TAU * k) / seg; pts.push([a * Math.cos(t), bb * Math.sin(t)]); }
  return pts;
};
export const rectSection = (hu, hv) => [[-hu, -hv], [hu, -hv], [hu, hv], [-hu, hv]];

// Axis-aligned box (optionally transformed).
export function box(b, x0, y0, z0, x1, y1, z1, transform) {
  const ring = (z) => [[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]];
  loft(b, [ring(z0), ring(z1)], { transform });
}

// Flat ring (washer) lying in the plane through `center` perpendicular to `normal`.
export function washer(b, center, normal, rMid, halfWidth, halfThick, seg = 32) {
  const nrm = vnorm(normal);
  const ref = Math.abs(nrm[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const e1 = vnorm(vcross(ref, nrm));
  const e2 = vcross(nrm, e1);
  const path = [];
  for (let k = 0; k < seg; k++) {
    const t = (TAU * k) / seg;
    path.push(vadd(center, vadd(vscale(e1, rMid * Math.cos(t)), vscale(e2, rMid * Math.sin(t)))));
  }
  loft(b, sweepRings(path, () => rectSection(halfWidth, halfThick), nrm, true), { closed: true });
}

// Curved, tapering horn/spike from `base` in direction `dir`, bending towards `bend`.
export function horn(b, base, dir, bend, length, baseRadius, rings = 8, seg = 10) {
  const d = vnorm(dir);
  let bn = vsub(bend, vscale(d, vdot(bend, d)));
  if (vlen(bn) < 1e-6) bn = Math.abs(d[2]) < 0.9 ? vcross(d, [0, 0, 1]) : vcross(d, [1, 0, 0]);
  bn = vnorm(bn);
  const path = [];
  for (let i = 0; i < rings; i++) {
    const s = i / (rings - 1);
    path.push(vadd(base, vadd(vscale(d, s * length), vscale(bn, s * s * length * 0.35))));
  }
  const B = vnorm(vcross(d, bn));
  const rs = sweepRings(path, (i, t) => circleSection(Math.max(0.15, baseRadius * (1 - 0.88 * t)), undefined, seg), B);
  const last = path[rings - 1], prev = path[rings - 2];
  const tip = vadd(last, vscale(vnorm(vsub(last, prev)), Math.max(0.4, baseRadius * 0.25)));
  loft(b, rs, { endCap: tip });
}

// ---------- icosphere ----------
export function icosphere(b, subdiv, radiusFn, center = [0, 0, 0], squashZ = null) {
  const t = (1 + Math.sqrt(5)) / 2;
  let verts = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map(vnorm);
  let faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  faces = faces.map(([a, bb, c]) => {
    const n = vcross(vsub(verts[bb], verts[a]), vsub(verts[c], verts[a]));
    return vdot(n, verts[a]) < 0 ? [a, c, bb] : [a, bb, c];
  });
  for (let s = 0; s < subdiv; s++) {
    const cache = new Map();
    const mid = (a, c) => {
      const k = a < c ? `${a}_${c}` : `${c}_${a}`;
      let m = cache.get(k);
      if (m === undefined) { m = verts.length; verts.push(vnorm(vscale(vadd(verts[a], verts[c]), 0.5))); cache.set(k, m); }
      return m;
    };
    const nf = [];
    for (const [a, bb, c] of faces) {
      const ab = mid(a, bb), bc = mid(bb, c), ca = mid(c, a);
      nf.push([a, ab, ca], [bb, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = nf;
  }
  b.begin();
  const base = b.vcount;
  for (const d of verts) {
    const r = radiusFn(d);
    let p = vadd(center, vscale(d, r));
    if (squashZ) p = squashZ(p);
    b.v(p[0], p[1], p[2]);
  }
  for (const [a, bb, c] of faces) b.tri(base + a, base + bb, base + c);
  b.end();
}

// ---------- polygons & prisms ----------
export function signedArea2D(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

function cross2(a, b, c) { return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]); }
function pointInTri(p, a, b, c) {
  const d1 = cross2(a, b, p), d2 = cross2(b, c, p), d3 = cross2(c, a, p);
  return d1 >= -1e-12 && d2 >= -1e-12 && d3 >= -1e-12;
}

// Removes consecutive duplicates and collinear points.
export function cleanPolygon(poly, eps = 1e-9) {
  let pts = poly.filter((p, i) => {
    const q = poly[(i + 1) % poly.length];
    return Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6;
  });
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i - 1 + pts.length) % pts.length], bb = pts[i], c = pts[(i + 1) % pts.length];
      if (Math.abs(cross2(a, bb, c)) < eps) { pts.splice(i, 1); changed = true; break; }
    }
  }
  return pts;
}

// Ear clipping for a simple counter-clockwise polygon.
export function earClip(pts) {
  const idx = pts.map((_, i) => i);
  const tris = [];
  let guard = 0;
  while (idx.length > 3) {
    if (guard++ > 100000) throw new Error('earClip: no progress');
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i - 1 + idx.length) % idx.length], ib = idx[i], ic = idx[(i + 1) % idx.length];
      const a = pts[ia], bb = pts[ib], c = pts[ic];
      if (cross2(a, bb, c) <= 1e-10) continue;
      let inside = false;
      for (const k of idx) {
        if (k === ia || k === ib || k === ic) continue;
        if (pointInTri(pts[k], a, bb, c)) { inside = true; break; }
      }
      if (inside) continue;
      tris.push([ia, ib, ic]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) throw new Error('earClip: polygon is not simple');
  }
  tris.push([idx[0], idx[1], idx[2]]);
  return tris;
}

// Extrude a 2D polygon [(u,v)] from w0 to w1; map(u,v,w) places it in the world (any affine map).
export function prism(b, polygon, w0, w1, map = (u, v, w) => [u, v, w]) {
  let poly = cleanPolygon(polygon);
  if (signedArea2D(poly) < 0) poly = poly.slice().reverse();
  const tris = earClip(poly);
  b.begin();
  const bot = poly.map(([u, v]) => { const p = map(u, v, w0); return b.v(p[0], p[1], p[2]); });
  const top = poly.map(([u, v]) => { const p = map(u, v, w1); return b.v(p[0], p[1], p[2]); });
  for (const [i, j, k] of tris) { b.tri(top[i], top[j], top[k]); b.tri(bot[i], bot[k], bot[j]); }
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    b.tri(bot[i], bot[j], top[j]);
    b.tri(bot[i], top[j], top[i]);
  }
  b.end(); // end() flips the part if the map mirrored it
}

// ---------- 1D interpolation ----------
// Monotone cubic (PCHIP) interpolation through (xs[i], ys[i]); no overshoot.
export function pchip(xs, ys) {
  const n = xs.length;
  const h = [], d = [];
  for (let i = 0; i < n - 1; i++) { h.push(xs[i + 1] - xs[i]); d.push((ys[i + 1] - ys[i]) / h[i]); }
  const m = new Array(n).fill(0);
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) m[i] = 0;
    else {
      const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const t = (x - xs[i]) / h[i];
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h[i] * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h[i] * m[i + 1];
  };
}

export function bezier2D(p0, p1, p2, p3, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1), u = 1 - t;
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
  return out;
}

export function gcd(a, b) { return b ? gcd(b, a % b) : a; }
export function lcm(a, b) { return (a * b) / gcd(a, b); }
// A segment count near `target` that is a multiple of every number in `multiples`.
export function segmentsFor(target, ...multiples) {
  const l = multiples.filter(Boolean).reduce((acc, m) => lcm(acc, m), 1);
  return l * Math.max(1, Math.round(target / l));
}

// ---------- rounded 2D outlines ----------
// Replace each corner of a polygon by an arc of radius ≤ r (clamped to the adjacent edges).
export function roundCorners(poly, r, seg = 5, { bedEps = 1e-6 } = {}) {
  const n = poly.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const p0 = poly[(i - 1 + n) % n], p1 = poly[i], p2 = poly[(i + 1) % n];
    const d0 = [p0[0] - p1[0], p0[1] - p1[1]], d1 = [p2[0] - p1[0], p2[1] - p1[1]];
    const l0 = Math.hypot(d0[0], d0[1]), l1 = Math.hypot(d1[0], d1[1]);
    if (l0 < 1e-9 || l1 < 1e-9) { out.push(p1); continue; }
    const u0 = [d0[0] / l0, d0[1] / l0], u1 = [d1[0] / l1, d1[1] / l1];
    const ang = Math.acos(Math.max(-1, Math.min(1, u0[0] * u1[0] + u0[1] * u1[1])));
    if (ang > Math.PI - 1e-3 || ang < 1e-3) { out.push(p1); continue; }
    if (p1[1] <= bedEps) {
      // A corner on the bed: an arc here would face downwards, so use a steep (≥ 50°) chamfer instead.
      const t0 = Math.min(0.45 * l0, Math.abs(u0[1]) < 1e-6 ? 0.8 : 1.0);
      const t1 = Math.min(0.45 * l1, Math.abs(u1[1]) < 1e-6 ? 0.8 : 1.0);
      out.push([p1[0] + u0[0] * t0, p1[1] + u0[1] * t0], [p1[0] + u1[0] * t1, p1[1] + u1[1] * t1]);
      continue;
    }
    const t = Math.min(r / Math.tan(ang / 2), 0.45 * l0, 0.45 * l1);
    const rad = t * Math.tan(ang / 2);
    const a = [p1[0] + u0[0] * t, p1[1] + u0[1] * t];
    const c = [p1[0] + u1[0] * t, p1[1] + u1[1] * t];
    const bis = vnorm([u0[0] + u1[0], u0[1] + u1[1], 0]);
    const cen = [p1[0] + bis[0] * (rad / Math.sin(ang / 2)), p1[1] + bis[1] * (rad / Math.sin(ang / 2))];
    const a0 = Math.atan2(a[1] - cen[1], a[0] - cen[0]);
    let da = Math.atan2(c[1] - cen[1], c[0] - cen[0]) - a0;
    while (da > Math.PI) da -= TAU;
    while (da < -Math.PI) da += TAU;
    for (let k = 0; k <= seg; k++) { const aa = a0 + (da * k) / seg; out.push([cen[0] + rad * Math.cos(aa), cen[1] + rad * Math.sin(aa)]); }
  }
  return out;
}

// Extrude a 2D outline (u = across, v = up, v = 0 on the bed) from w0 to w1 with a chamfer on all
// edges except the bed edge: the end rings are the outline shrunk about (cu, 0).
export function extrudeChamfer(b, polygon, w0, w1, chamfer, map = (u, v, w) => [u, w, v], { about = null, ends = 'both' } = {}) {
  let poly = cleanPolygon(polygon);
  if (signedArea2D(poly) < 0) poly = poly.slice().reverse();
  const tris = earClip(poly);
  const minU = Math.min(...poly.map((p) => p[0])), maxU = Math.max(...poly.map((p) => p[0]));
  const minV = Math.min(...poly.map((p) => p[1])), maxV = Math.max(...poly.map((p) => p[1]));
  const [cu, cv] = about || [(minU + maxU) / 2, 0];
  const ext = Math.max(maxV - cv, cv - minV, maxU - cu, cu - minU, 1);
  const k = 1 - chamfer / ext;
  const shrink = (p) => [cu + (p[0] - cu) * k, cv + (p[1] - cv) * k];
  const c = Math.min(chamfer, (w1 - w0) / 2 - 0.1);
  const s0 = ends === 'both' || ends === 'start', s1 = ends === 'both' || ends === 'end';
  const rings = [
    (s0 ? poly.map(shrink) : poly).map(([u, v]) => map(u, v, w0)),
    poly.map(([u, v]) => map(u, v, w0 + (s0 ? c : 0.001))),
    poly.map(([u, v]) => map(u, v, w1 - (s1 ? c : 0.001))),
    (s1 ? poly.map(shrink) : poly).map(([u, v]) => map(u, v, w1)),
  ];
  b.begin();
  const ids = rings.map((ring) => ring.map((p) => b.v(p[0], p[1], p[2])));
  const M = poly.length;
  for (let i = 0; i < ids.length - 1; i++) {
    for (let j = 0; j < M; j++) {
      const j1 = (j + 1) % M;
      b.tri(ids[i][j], ids[i][j1], ids[i + 1][j1]);
      b.tri(ids[i][j], ids[i + 1][j1], ids[i + 1][j]);
    }
  }
  for (const [i, j, kk] of tris) { b.tri(ids[0][i], ids[0][kk], ids[0][j]); b.tri(ids[3][i], ids[3][j], ids[3][kk]); }
  b.end();
}

// Ellipsoid (rounded blob). `rot` is an optional orientation transform applied about the centre.
export function ellipsoid(b, center, rx, ry, rz, rot = null, subdiv = 3) {
  icosphere(b, subdiv, () => 1, [0, 0, 0], (p) => {
    let q = [p[0] * rx, p[1] * ry, p[2] * rz];
    if (rot) q = rot(q[0], q[1], q[2]);
    return vadd(center, q);
  });
}

// Tube along a 3D path. Rings are circles of radius(t) carried along the path with a parallel-transport
// frame (no twisting). When `keel` is set and the path is not near-vertical, the lower part of each ring
// is replaced by two tangents meeting below the axis at `keelDeg` from horizontal, so the underside
// prints without supports.
// `bump(t, i, dir)` (optional) returns an extra radial fraction for the point in world direction `dir`
// (unit vector from the axis), for textures such as scales that stay part of the same solid.
export function tube(b, path, radius, { keel = true, seg = 20, caps = 'flat', keelDeg = 50, bump = null } = {}) {
  const n = path.length;
  const rings = [];
  const K = (keelDeg * Math.PI) / 180;
  let N = null;
  for (let i = 0; i < n; i++) {
    const prev = path[Math.max(0, i - 1)], next = path[Math.min(n - 1, i + 1)];
    const T = vnorm(vsub(next, prev));
    if (!N) N = vnorm(vcross(Math.abs(T[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], T));
    else N = vnorm(vsub(N, vscale(T, vdot(N, T))));
    const B = vcross(T, N);
    const r = typeof radius === 'function' ? radius(i / (n - 1), i) : radius;
    // world down projected into the ring plane
    const down = vsub([0, 0, -1], vscale(T, vdot([0, 0, -1], T)));
    const dl = vlen(down);
    const w = keel ? Math.min(1, Math.max(0, (dl - 0.15) / 0.2)) : 0;
    const aDown = dl > 1e-6 ? Math.atan2(vdot(down, B), vdot(down, N)) : 0;
    const ring = [];
    for (let k = 0; k < seg; k++) {
      const a = (TAU * k) / seg;
      let L = 1;
      if (w > 0) {
        let d = a - aDown;
        while (d > Math.PI) d -= TAU;
        while (d < -Math.PI) d += TAU;
        const alpha = Math.abs(d);
        if (alpha < K) L = 1 + w * (1 / Math.cos(alpha - K) - 1);
      }
      let rr = r * L;
      if (bump) rr *= 1 + bump(i / (n - 1), i, vadd(vscale(N, Math.cos(a)), vscale(B, Math.sin(a))));
      ring.push(vadd(path[i], vadd(vscale(N, rr * Math.cos(a)), vscale(B, rr * Math.sin(a)))));
    }
    rings.push(ring);
  }
  loft(b, rings, { startCap: caps === 'flat' ? 'centroid' : caps[0], endCap: caps === 'flat' ? 'centroid' : caps[1] });
}

// A rounded button standing on a surface: cylinder of `radius` along `normal` from `depth` below the
// surface to `height` above it, with a fillet of radius `fillet` on the top edge. Built as a keeled
// tube. The normal must be vertical or horizontal (a tilted stud has a down-facing buried base).
export function stud(b, base, normal, radius, height, { depth = 1.3, fillet = radius * 0.5, seg = 20 } = {}) {
  const nrm = vnorm(normal);
  const f = Math.min(fillet, radius - 0.4, height);
  const ss = [-depth, -depth * 0.5, 0, Math.max(0.01, (height - f) * 0.5), height - f];
  const rs = [radius, radius, radius, radius, radius];
  for (let k = 1; k <= 5; k++) {
    const a = (Math.PI / 2) * (k / 5);
    ss.push(height - f + f * Math.sin(a));
    rs.push(radius - f + f * Math.cos(a));
  }
  const path = ss.map((s) => vadd(base, vscale(nrm, s)));
  tube(b, path, (t, i) => Math.max(0.4, rs[i]), { keel: true, seg });
}

// Ellipsoid whose lower part is clamped to a cone (≤ 42° from vertical) from its lowest point, so a
// blob half-buried in another part never has a down-facing underside.
export function blob(b, center, rx, ry, rz, rot = null, subdiv = 3) {
  const sub = new Builder();
  ellipsoid(sub, center, rx, ry, rz, rot, subdiv);
  let zMin = Infinity, ax = 0, ay = 0;
  for (let i = 0; i < sub.pos.length; i += 3) if (sub.pos[i + 2] < zMin) { zMin = sub.pos[i + 2]; ax = sub.pos[i]; ay = sub.pos[i + 1]; }
  const slope = Math.tan((42 * Math.PI) / 180);
  for (let i = 0; i < sub.pos.length; i += 3) {
    const h = sub.pos[i + 2] - zMin;
    const dx = sub.pos[i] - ax, dy = sub.pos[i + 1] - ay;
    const d = Math.hypot(dx, dy), allowed = h * slope;
    if (d > allowed && d > 1e-9) { sub.pos[i] = ax + (dx * allowed) / d; sub.pos[i + 1] = ay + (dy * allowed) / d; }
  }
  const off = b.vcount;
  for (let i = 0; i < sub.pos.length; i += 3) b.pos.push(sub.pos[i], sub.pos[i + 1], sub.pos[i + 2]);
  for (const i of sub.idx) b.idx.push(i + off);
}
