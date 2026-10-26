// Software renderer for product "photos" of a mesh. Pure JS, Node built-ins only.
//
//   renderRGBA(mesh, opts) -> { data: Uint8Array (RGBA), width, height }
//   renderPNG(mesh, opts)  -> Buffer (PNG file)
//
// A mesh is { positions: Float32Array, indices: Uint32Array } in millimetres, Z up.
// Pipeline: perspective camera fitted to the projected model -> z-buffered rasterisation
// (triangle id per sample) -> deferred shading in linear light (key/fill/rim, hemisphere
// ambient, satin specular, fresnel environment, faint FDM layer lines) -> soft contact
// shadow from a top-down height map -> supersample box filter -> sRGB.

import { computeBBox, signedVolume } from './core.js';
import { encodePNG } from './png.js';

const DEG = Math.PI / 180;

const VIEWS = {
  iso: { yaw: 35, pitch: 30 },
  hero: { yaw: 28, pitch: 13 },
  front: { yaw: 0, pitch: 10 },
  side: { yaw: 90, pitch: 10 },
  top: { yaw: 0, pitch: 89 },
};

const DEFAULTS = {
  width: 640,
  height: 640,
  color: '#D6246E',
  background: ['#F4F5F3', '#E3E6E8'],
  view: 'iso',
  yawDeg: undefined,
  pitchDeg: undefined,
  supersample: 2,
  shadow: true,
  layerLines: true,
  padding: 0.12,
  creaseDeg: 35,
  fovDeg: 30,
  refine: true, // subdivide coarse meshes so per-vertex shading has enough detail
  ao: true, // ambient occlusion (darkens cavities and joints)
  cull: false, // true = skip back faces (faster, but open/flipped meshes may show holes)
};

// ---------- colour helpers ----------

function parseHex(hex) {
  let h = String(hex || '').trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) h = 'D6246E';
  const n = parseInt(h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const linHex = (hex) => parseHex(hex).map(srgbToLinear);

const LUT_SIZE = 4096;
const SRGB_LUT = (() => {
  const lut = new Uint8Array(LUT_SIZE + 1);
  for (let i = 0; i <= LUT_SIZE; i++) {
    const l = i / LUT_SIZE;
    const s = l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
    lut[i] = Math.max(0, Math.min(255, Math.round(s * 255)));
  }
  return lut;
})();
function toSrgb8(l) {
  if (!(l > 0)) return 0;
  if (l >= 1) return 255;
  return SRGB_LUT[(l * LUT_SIZE + 0.5) | 0];
}

// Soft highlight roll-off so white filament keeps its form instead of clipping.
const KNEE = 0.72;
function tone(x) {
  if (x <= KNEE) return x < 0 ? 0 : x;
  return KNEE + (1 - KNEE) * (1 - Math.exp(-(x - KNEE) / (1 - KNEE)));
}

// ---------- vector helpers ----------

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function norm(a) {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
const comb = (a, ka, b, kb, c, kc) => [
  a[0] * ka + b[0] * kb + (c ? c[0] * kc : 0),
  a[1] * ka + b[1] * kb + (c ? c[1] * kc : 0),
  a[2] * ka + b[2] * kb + (c ? c[2] * kc : 0),
];

// ---------- normals with crease angle ----------

// Per-corner normals: each face corner averages (angle-weighted) the normals of the faces
// around its vertex that are within the crease angle of this face. Smooth on curved
// surfaces, crisp on box edges.
function cornerNormals(positions, indices, creaseDeg) {
  const nt = indices.length / 3;
  const nv = positions.length / 3;
  const fn = new Float32Array(nt * 3);
  const ang = new Float32Array(nt * 3);
  for (let t = 0; t < nt; t++) {
    const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
    const abx = positions[b] - positions[a], aby = positions[b + 1] - positions[a + 1], abz = positions[b + 2] - positions[a + 2];
    const acx = positions[c] - positions[a], acy = positions[c + 1] - positions[a + 1], acz = positions[c + 2] - positions[a + 2];
    const bcx = positions[c] - positions[b], bcy = positions[c + 1] - positions[b + 1], bcz = positions[c + 2] - positions[b + 2];
    let nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
    const l = Math.hypot(nx, ny, nz);
    if (l > 0) { nx /= l; ny /= l; nz /= l; }
    fn[t * 3] = nx; fn[t * 3 + 1] = ny; fn[t * 3 + 2] = nz;
    const lab = Math.hypot(abx, aby, abz) || 1, lac = Math.hypot(acx, acy, acz) || 1, lbc = Math.hypot(bcx, bcy, bcz) || 1;
    const angA = Math.acos(Math.max(-1, Math.min(1, (abx * acx + aby * acy + abz * acz) / (lab * lac))));
    const angB = Math.acos(Math.max(-1, Math.min(1, (-abx * bcx - aby * bcy - abz * bcz) / (lab * lbc))));
    ang[t * 3] = angA; ang[t * 3 + 1] = angB; ang[t * 3 + 2] = Math.max(0, Math.PI - angA - angB);
  }
  // vertex -> incident corners (CSR)
  const start = new Uint32Array(nv + 1);
  for (let i = 0; i < indices.length; i++) start[indices[i] + 1]++;
  for (let v = 0; v < nv; v++) start[v + 1] += start[v];
  const fill = start.slice(0, nv);
  const corners = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) corners[fill[indices[i]]++] = i;

  const cosC = Math.cos(creaseDeg * DEG);
  const cn = new Float32Array(nt * 9);
  for (let t = 0; t < nt; t++) {
    const fx = fn[t * 3], fy = fn[t * 3 + 1], fz = fn[t * 3 + 2];
    for (let k = 0; k < 3; k++) {
      const v = indices[t * 3 + k];
      let sx = 0, sy = 0, sz = 0;
      for (let j = start[v]; j < start[v + 1]; j++) {
        const c = corners[j];
        const g = (c / 3) | 0;
        const gx = fn[g * 3], gy = fn[g * 3 + 1], gz = fn[g * 3 + 2];
        if (fx * gx + fy * gy + fz * gz >= cosC) {
          const w = ang[c];
          sx += gx * w; sy += gy * w; sz += gz * w;
        }
      }
      let l = Math.hypot(sx, sy, sz);
      if (l === 0) { sx = fx; sy = fy; sz = fz; l = Math.hypot(sx, sy, sz) || 1; }
      const o = t * 9 + k * 3;
      cn[o] = sx / l; cn[o + 1] = sy / l; cn[o + 2] = sz / l;
    }
  }
  return cn;
}

// ---------- contact shadow height map ----------

function boxBlur(src, n, radius, passes) {
  if (radius < 1) return src;
  let a = src, b = new Float32Array(n * n);
  const win = 2 * radius + 1;
  for (let p = 0; p < passes; p++) {
    // horizontal
    for (let y = 0; y < n; y++) {
      const row = y * n;
      let acc = 0;
      for (let x = -radius; x <= radius; x++) acc += x >= 0 && x < n ? a[row + x] : 0;
      for (let x = 0; x < n; x++) {
        b[row + x] = acc / win;
        const add = x + radius + 1, rem = x - radius;
        acc += (add < n ? a[row + add] : 0) - (rem >= 0 ? a[row + rem] : 0);
      }
    }
    // vertical
    const c = a === src ? new Float32Array(n * n) : a;
    for (let x = 0; x < n; x++) {
      let acc = 0;
      for (let y = -radius; y <= radius; y++) acc += y >= 0 && y < n ? b[y * n + x] : 0;
      for (let y = 0; y < n; y++) {
        c[y * n + x] = acc / win;
        const add = y + radius + 1, rem = y - radius;
        acc += (add < n ? b[add * n + x] : 0) - (rem >= 0 ? b[rem * n + x] : 0);
      }
    }
    a = c;
  }
  return a;
}

function buildShadowMap(positions, indices, bb) {
  const [sx, sy, sz] = bb.size;
  const margin = 0.5 * Math.max(sx, sy, sz * 0.6) + 2;
  const ext = Math.max(sx, sy) + 2 * margin;
  const N = 160;
  const cell = ext / N;
  const x0 = (bb.min[0] + bb.max[0]) / 2 - ext / 2;
  const y0 = (bb.min[1] + bb.max[1]) / 2 - ext / 2;
  const zFloor = bb.min[2];
  const zmin = new Float32Array(N * N).fill(Infinity);

  const gx = (x) => (x - x0) / cell - 0.5;
  const gy = (y) => (y - y0) / cell - 0.5;
  // splat vertices so tiny triangles still register
  for (let i = 0; i < positions.length; i += 3) {
    const cx = Math.round(gx(positions[i])), cy = Math.round(gy(positions[i + 1]));
    if (cx >= 0 && cy >= 0 && cx < N && cy < N) {
      const k = cy * N + cx;
      if (positions[i + 2] < zmin[k]) zmin[k] = positions[i + 2];
    }
  }
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ax = gx(positions[a]), ay = gy(positions[a + 1]), az = positions[a + 2];
    const bx = gx(positions[b]), by = gy(positions[b + 1]), bz = positions[b + 2];
    const cx = gx(positions[c]), cy = gy(positions[c + 1]), cz = positions[c + 2];
    const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (Math.abs(area) < 1e-9) continue;
    const inv = 1 / area;
    const minX = Math.max(0, Math.ceil(Math.min(ax, bx, cx))), maxX = Math.min(N - 1, Math.floor(Math.max(ax, bx, cx)));
    const minY = Math.max(0, Math.ceil(Math.min(ay, by, cy))), maxY = Math.min(N - 1, Math.floor(Math.max(ay, by, cy)));
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const w0 = ((cx - bx) * (y - by) - (cy - by) * (x - bx)) * inv;
        const w1 = ((ax - cx) * (y - cy) - (ay - cy) * (x - cx)) * inv;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
        const z = w0 * az + w1 * bz + w2 * cz;
        const k = y * N + x;
        if (z < zmin[k]) zmin[k] = z;
      }
    }
  }
  // Occupancy weighted by how close the geometry is to the floor.
  const falloff = 0.35 * sz + 1;
  const occ = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) {
    if (zmin[i] !== Infinity) occ[i] = Math.exp(-(zmin[i] - zFloor) / falloff);
  }
  const tight = boxBlur(occ, N, Math.max(1, Math.round(N * 0.022)), 3);
  const wide = boxBlur(occ, N, Math.max(2, Math.round(N * 0.07)), 3);
  const data = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) data[i] = Math.min(1, 0.9 * tight[i] + 0.5 * wide[i]);
  return { x0, y0, cell, N, data, zFloor };
}

function sampleShadow(sm, x, y) {
  const fx = (x - sm.x0) / sm.cell - 0.5, fy = (y - sm.y0) / sm.cell - 0.5;
  const N = sm.N;
  if (fx < 0 || fy < 0 || fx >= N - 1 || fy >= N - 1) return 0;
  const ix = fx | 0, iy = fy | 0, tx = fx - ix, ty = fy - iy;
  const d = sm.data, k = iy * N + ix;
  return (d[k] * (1 - tx) + d[k + 1] * tx) * (1 - ty) + (d[k + N] * (1 - tx) + d[k + N + 1] * tx) * ty;
}


// ---------- ambient occlusion (per vertex, voxel ray casting) ----------

// Voxelise the surface, then cast a small fan of hemisphere rays from every vertex.
// Rays that hit geometry (or the floor the model stands on) close by darken that vertex.
// Gives mug interiors, handle joints and the foot of a vase their natural depth.
const AO_DIRS = (() => {
  const dirs = [];
  const K = 14;
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < K; i++) {
    // cosine-weighted, limited to ~72° from the normal to avoid grazing self-hits
    const u = (i + 0.5) / K;
    const r = Math.sqrt(u) * 0.95;
    const z = Math.sqrt(Math.max(0, 1 - r * r));
    const phi = i * golden;
    dirs.push([r * Math.cos(phi), r * Math.sin(phi), z]);
  }
  return dirs;
})();

function vertexAO(positions, indices, bb) {
  const nv = positions.length / 3;
  const ao = new Float32Array(nv).fill(1);
  const maxDim = Math.max(bb.size[0], bb.size[1], bb.size[2]);
  if (!(maxDim > 0)) return ao;
  const G = 84;
  const cell = maxDim / (G - 6);
  const gx = Math.ceil(bb.size[0] / cell) + 6, gy = Math.ceil(bb.size[1] / cell) + 6, gz = Math.ceil(bb.size[2] / cell) + 6;
  const ox = bb.min[0] - 3 * cell, oy = bb.min[1] - 3 * cell, oz = bb.min[2] - 3 * cell;
  const occ = new Uint8Array(gx * gy * gz);
  const invCell = 1 / cell;
  const gxy = gx * gy;

  // surface voxelisation by dense barycentric sampling
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
    const ux = positions[b] - ax, uy = positions[b + 1] - ay, uz = positions[b + 2] - az;
    const vx = positions[c] - ax, vy = positions[c + 1] - ay, vz = positions[c + 2] - az;
    const e = Math.max(Math.hypot(ux, uy, uz), Math.hypot(vx, vy, vz), Math.hypot(vx - ux, vy - uy, vz - uz));
    const n = Math.max(1, Math.ceil(e * invCell * 1.8));
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n - i; j++) {
        const s = i / n, q = j / n;
        const ix = ((ax + s * ux + q * vx - ox) * invCell) | 0;
        const iy = ((ay + s * uy + q * vy - oy) * invCell) | 0;
        const iz = ((az + s * uz + q * vz - oz) * invCell) | 0;
        occ[iz * gxy + iy * gx + ix] = 1;
      }
    }
  }

  // smooth vertex normals (area weighted)
  const vn = new Float32Array(nv * 3);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t], b = indices[t + 1], c = indices[t + 2];
    const a3 = a * 3, b3 = b * 3, c3 = c * 3;
    const ux = positions[b3] - positions[a3], uy = positions[b3 + 1] - positions[a3 + 1], uz = positions[b3 + 2] - positions[a3 + 2];
    const vx = positions[c3] - positions[a3], vy = positions[c3 + 1] - positions[a3 + 1], vz = positions[c3 + 2] - positions[a3 + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const v of [a3, b3, c3]) { vn[v] += nx; vn[v + 1] += ny; vn[v + 2] += nz; }
  }

  const maxDist = 0.42 * maxDim;
  const step = 0.8 * cell;
  const steps = Math.ceil(maxDist / step);
  const start = 1.7 * cell;
  const floorZ = bb.min[2] - 0.25 * cell;
  const K = AO_DIRS.length;
  for (let v = 0; v < nv; v++) {
    let nx = vn[v * 3], ny = vn[v * 3 + 1], nz = vn[v * 3 + 2];
    const nl = Math.hypot(nx, ny, nz);
    if (nl === 0) continue;
    nx /= nl; ny /= nl; nz /= nl;
    // orthonormal frame around the normal, rotated per vertex to break up banding
    let tx, ty, tz;
    if (Math.abs(nz) < 0.9) { tx = -ny; ty = nx; tz = 0; } else { tx = 0; ty = -nz; tz = ny; }
    const tl = Math.hypot(tx, ty, tz); tx /= tl; ty /= tl; tz /= tl;
    const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
    const rot = ((v * 2654435761) >>> 0) / 4294967296 * Math.PI * 2;
    const cr = Math.cos(rot), sr = Math.sin(rot);
    const px = positions[v * 3] + nx * start, py = positions[v * 3 + 1] + ny * start, pz = positions[v * 3 + 2] + nz * start;
    let blocked = 0;
    for (let k = 0; k < K; k++) {
      const d = AO_DIRS[k];
      const lx = d[0] * cr - d[1] * sr, ly = d[0] * sr + d[1] * cr, lz = d[2];
      const dx = tx * lx + bx * ly + nx * lz, dy = ty * lx + by * ly + ny * lz, dz = tz * lx + bz * ly + nz * lz;
      for (let s = 1; s <= steps; s++) {
        const dist = s * step;
        const qz = pz + dz * dist;
        if (qz < floorZ) { blocked += 0.4 * (1 - dist / maxDist); break; }
        const ix = ((px + dx * dist - ox) * invCell) | 0;
        const iy = ((py + dy * dist - oy) * invCell) | 0;
        const iz = ((qz - oz) * invCell) | 0;
        if (ix < 0 || iy < 0 || iz < 0 || ix >= gx || iy >= gy || iz >= gz) break;
        if (occ[iz * gxy + iy * gx + ix]) { blocked += 1 - 0.6 * (dist / maxDist); break; }
      }
    }
    ao[v] = 1 - blocked / K;
  }
  // Two passes of neighbour averaging remove ray noise (and banding on lathe-turned shapes).
  const sum = new Float32Array(nv), cnt = new Float32Array(nv);
  for (let pass = 0; pass < 2; pass++) {
    sum.fill(0); cnt.fill(0);
    for (let t = 0; t < indices.length; t += 3) {
      const a = indices[t], b = indices[t + 1], c = indices[t + 2];
      sum[a] += ao[b] + ao[c]; cnt[a] += 2;
      sum[b] += ao[a] + ao[c]; cnt[b] += 2;
      sum[c] += ao[a] + ao[b]; cnt[c] += 2;
    }
    for (let v = 0; v < nv; v++) if (cnt[v] > 0) ao[v] = 0.4 * ao[v] + 0.6 * (sum[v] / cnt[v]);
  }
  return ao;
}

// ---------- tessellation for shading detail ----------

// Split long triangles (longest-edge bisection, shared midpoints) so per-vertex effects such
// as ambient occlusion have enough vertices on big flat faces. Dense meshes are left alone.
function refine(positions, indices, cn, bb, maxTris = 30000) {
  const nt0 = indices.length / 3;
  if (nt0 >= 15000) return { positions, indices, cn };
  const maxDim = Math.max(bb.size[0], bb.size[1], bb.size[2]) || 1;
  const limit = maxDim / 16, limit2 = limit * limit;
  const pos = Array.from(positions);
  let tris = Array.from(indices);
  let nrm = Array.from(cn); // 9 per triangle: corner normals, interpolated along with positions
  const mid = new Map();
  const midpoint = (a, b) => {
    const key = a < b ? a * 4194304 + b : b * 4194304 + a;
    let m = mid.get(key);
    if (m === undefined) {
      m = pos.length / 3;
      pos.push((pos[a * 3] + pos[b * 3]) / 2, (pos[a * 3 + 1] + pos[b * 3 + 1]) / 2, (pos[a * 3 + 2] + pos[b * 3 + 2]) / 2);
      mid.set(key, m);
    }
    return m;
  };
  const d2 = (a, b) => {
    const x = pos[a * 3] - pos[b * 3], y = pos[a * 3 + 1] - pos[b * 3 + 1], z = pos[a * 3 + 2] - pos[b * 3 + 2];
    return x * x + y * y + z * z;
  };
  const ekey = (a, b) => (a < b ? a * 4194304 + b : b * 4194304 + a);
  // Conforming refinement: every triangle that touches a marked edge splits it too,
  // so no T-junctions appear. Geometry is unchanged; normals are interpolated so curved
  // surfaces stay smooth.
  for (let pass = 0; pass < 12; pass++) {
    const marked = new Set();
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t], b = tris[t + 1], c = tris[t + 2];
      const ab = d2(a, b), bc = d2(b, c), ca = d2(c, a);
      const m = Math.max(ab, bc, ca);
      if (m <= limit2) continue;
      marked.add(m === ab ? ekey(a, b) : m === bc ? ekey(b, c) : ekey(c, a));
    }
    if (marked.size === 0 || tris.length / 3 + marked.size * 2 > maxTris) break;
    const next = [], nextN = [];
    for (let t = 0; t < tris.length; t += 3) {
      const o = t * 3;
      // corners as [vertexIndex, nx, ny, nz]
      let A = [tris[t], nrm[o], nrm[o + 1], nrm[o + 2]];
      let B = [tris[t + 1], nrm[o + 3], nrm[o + 4], nrm[o + 5]];
      let C = [tris[t + 2], nrm[o + 6], nrm[o + 7], nrm[o + 8]];
      const mab = marked.has(ekey(A[0], B[0])), mbc = marked.has(ekey(B[0], C[0])), mca = marked.has(ekey(C[0], A[0]));
      const n = mab + mbc + mca;
      const emit = (...cs) => { for (const c of cs) { next.push(c[0]); nextN.push(c[1], c[2], c[3]); } };
      const M = (P, Q) => {
        const x = P[1] + Q[1], y = P[2] + Q[2], z = P[3] + Q[3];
        const l = Math.hypot(x, y, z) || 1;
        return [midpoint(P[0], Q[0]), x / l, y / l, z / l];
      };
      if (n === 0) { emit(A, B, C); continue; }
      if (n === 3) {
        const p = M(A, B), q = M(B, C), r = M(C, A);
        emit(A, p, r, p, B, q, r, q, C, p, q, r);
        continue;
      }
      if (n === 1) {
        if (mab) { const p = M(A, B); emit(A, p, C, p, B, C); }
        else if (mbc) { const p = M(B, C); emit(A, B, p, A, p, C); }
        else { const p = M(C, A); emit(A, B, p, p, B, C); }
        continue;
      }
      // two marked edges: rotate so they are (A,B) and (B,C)
      if (!mab) { const t0 = A; A = B; B = C; C = t0; }
      else if (!mbc) { const t0 = C; C = B; B = A; A = t0; }
      const p = M(A, B), q = M(B, C);
      emit(p, B, q, A, p, q, A, q, C);
    }
    tris = next;
    nrm = nextN;
  }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(tris), cn: Float32Array.from(nrm) };
}

// ---------- main ----------

export function renderRGBA(mesh, options = {}) {
  const o = { ...DEFAULTS };
  for (const [k, v] of Object.entries(options || {})) if (v !== undefined) o[k] = v;
  const W = Math.max(1, o.width | 0), H = Math.max(1, o.height | 0);
  const S = Math.max(1, Math.min(4, o.supersample | 0));
  const Ws = W * S, Hs = H * S;

  let positions = mesh?.positions || new Float32Array(0);
  let indices = mesh?.indices || new Uint32Array(0);

  // Background gradient (linear light) at output resolution; the contact shadow is added later.
  const bgList = Array.isArray(o.background) ? o.background : [o.background, o.background];
  const bgTop = linHex(bgList[0]), bgBot = linHex(bgList[bgList.length - 1]);
  const bgOut = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    const t = H > 1 ? y / (H - 1) : 0;
    const r0 = bgTop[0] + (bgBot[0] - bgTop[0]) * t, g0 = bgTop[1] + (bgBot[1] - bgTop[1]) * t, b0 = bgTop[2] + (bgBot[2] - bgTop[2]) * t;
    for (let x = 0; x < W; x++) { const k = (y * W + x) * 3; bgOut[k] = r0; bgOut[k + 1] = g0; bgOut[k + 2] = b0; }
  }

  const out = new Uint8Array(W * H * 4);
  const accum = new Float32Array(Ws * Hs * 3);

  const finish = () => {
    const inv = 1 / (S * S);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let r = 0, g = 0, b = 0;
        for (let sy = 0; sy < S; sy++) {
          let k = ((y * S + sy) * Ws + x * S) * 3;
          for (let sx = 0; sx < S; sx++, k += 3) { r += accum[k]; g += accum[k + 1]; b += accum[k + 2]; }
        }
        const p = (y * W + x) * 4;
        out[p] = toSrgb8(r * inv); out[p + 1] = toSrgb8(g * inv); out[p + 2] = toSrgb8(b * inv); out[p + 3] = 255;
      }
    }
    return { data: out, width: W, height: H };
  };

  const fillBackground = () => {
    for (let y = 0; y < Hs; y++) for (let x = 0; x < Ws; x++) {
      const k = (y * Ws + x) * 3, b = (((y / S) | 0) * W + ((x / S) | 0)) * 3;
      accum[k] = bgOut[b]; accum[k + 1] = bgOut[b + 1]; accum[k + 2] = bgOut[b + 2];
    }
  };

  if (indices.length === 0 || positions.length === 0) { fillBackground(); return finish(); }

  const bb = computeBBox(mesh);
  let cn = cornerNormals(positions, indices, o.creaseDeg);
  if (o.refine) ({ positions, indices, cn } = refine(positions, indices, cn, bb));
  const nv = positions.length / 3, nt = indices.length / 3;

  // ---- camera ----
  const center = [(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2, (bb.min[2] + bb.max[2]) / 2];
  const radius = 0.5 * Math.hypot(bb.size[0], bb.size[1], bb.size[2]) || 1;
  const view = VIEWS[o.view] || VIEWS.iso;
  const yaw = (o.yawDeg ?? view.yaw) * DEG;
  const pitch = Math.max(-89.5, Math.min(89.5, o.pitchDeg ?? view.pitch)) * DEG;
  const fovHalf = Math.max(5, Math.min(80, o.fovDeg)) * DEG / 2;
  const dist = radius / Math.sin(fovHalf);
  const toCam = [Math.sin(yaw) * Math.cos(pitch), -Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch)];
  const eye = comb(center, 1, toCam, dist);
  const f = norm(sub(center, eye));
  let r = cross(f, [0, 0, 1]);
  if (Math.hypot(r[0], r[1], r[2]) < 1e-6) r = cross(f, [0, 1, 0]);
  r = norm(r);
  const u = cross(r, f);

  // Project every vertex to normalised camera space.
  const PX = new Float32Array(nv), PY = new Float32Array(nv), IZ = new Float32Array(nv);
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  for (let i = 0; i < nv; i++) {
    const dx = positions[i * 3] - eye[0], dy = positions[i * 3 + 1] - eye[1], dz = positions[i * 3 + 2] - eye[2];
    const zc = dx * f[0] + dy * f[1] + dz * f[2];
    const iz = zc > 1e-6 ? 1 / zc : 0;
    const px = (dx * r[0] + dy * r[1] + dz * r[2]) * iz;
    const py = (dx * u[0] + dy * u[1] + dz * u[2]) * iz;
    PX[i] = px; PY[i] = py; IZ[i] = iz;
    if (iz > 0) {
      if (px < minx) minx = px; if (px > maxx) maxx = px;
      if (py < miny) miny = py; if (py > maxy) maxy = py;
    }
  }
  const pad = Math.max(0, Math.min(0.45, o.padding));
  const spanX = Math.max(maxx - minx, 1e-6), spanY = Math.max(maxy - miny, 1e-6);
  const focal = Math.min((W * (1 - 2 * pad)) / spanX, (H * (1 - 2 * pad)) / spanY); // output pixels
  const ccx = W / 2 - focal * (minx + maxx) / 2;
  const ccy = H / 2 + focal * (miny + maxy) / 2;

  const SX = new Float32Array(nv), SY = new Float32Array(nv);
  for (let i = 0; i < nv; i++) {
    SX[i] = (ccx + focal * PX[i]) * S;
    SY[i] = (ccy - focal * PY[i]) * S;
  }

  // ---- rasterise visibility ----
  const orient = signedVolume({ positions, indices }) >= 0 ? 1 : -1; // +1: triangles face outward
  const zbuf = new Float32Array(Ws * Hs);
  const tbuf = new Int32Array(Ws * Hs).fill(-1);
  const backFacing = new Uint8Array(nt);
  const EPS = -1e-7;
  for (let t = 0; t < nt; t++) {
    const i0 = indices[t * 3], i1 = indices[t * 3 + 1], i2 = indices[t * 3 + 2];
    let iz0 = IZ[i0], iz1 = IZ[i1], iz2 = IZ[i2];
    if (iz0 <= 0 || iz1 <= 0 || iz2 <= 0) continue;
    const x0 = SX[i0], y0 = SY[i0], x1 = SX[i1], y1 = SY[i1], x2 = SX[i2], y2 = SY[i2];
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (!(Math.abs(area) > 1e-12)) continue;
    // Screen y points down, so a triangle wound CCW towards the camera has negative area.
    const back = area > 0;
    backFacing[t] = back ? 1 : 0;
    if (o.cull && (back ? orient > 0 : orient < 0)) continue;
    // Faces turned away from the camera lose ties at silhouettes against faces turned toward it.
    if ((back && orient > 0) || (!back && orient < 0)) { const k = 1 - 2e-4; iz0 *= k; iz1 *= k; iz2 *= k; }
    const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2))), maxX = Math.min(Ws - 1, Math.ceil(Math.max(x0, x1, x2)));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2))), maxY = Math.min(Hs - 1, Math.ceil(Math.max(y0, y1, y2)));
    if (minX > maxX || minY > maxY) continue;
    const inv = 1 / area;
    const a0 = -(y2 - y1) * inv, a1 = -(y0 - y2) * inv; // d(w)/dx
    for (let py = minY; py <= maxY; py++) {
      const yc = py + 0.5, xs = minX + 0.5;
      let w0 = ((x2 - x1) * (yc - y1) - (y2 - y1) * (xs - x1)) * inv;
      let w1 = ((x0 - x2) * (yc - y2) - (y0 - y2) * (xs - x2)) * inv;
      let idx = py * Ws + minX;
      for (let px = minX; px <= maxX; px++, idx++, w0 += a0, w1 += a1) {
        const w2 = 1 - w0 - w1;
        if (w0 < EPS || w1 < EPS || w2 < EPS) continue;
        const iz = w0 * iz0 + w1 * iz1 + w2 * iz2;
        if (iz > zbuf[idx]) { zbuf[idx] = iz; tbuf[idx] = t; }
      }
    }
  }

  // ---- lighting setup (relative to the camera so every view is lit the same way) ----
  const back = [-f[0], -f[1], -f[2]];
  // "Up" for the lights sits between world up and camera up, so a top-down shot is still
  // lit from one side instead of straight along the view axis.
  const Z = norm(comb([0, 0, 1], 1, u, 1));
  const Lk = norm(comb(r, -0.62, Z, 0.72, back, 0.55));
  const Lf = norm(comb(r, 0.75, Z, 0.12, back, 0.5));
  const Lr = norm(comb(r, 0.35, Z, 0.55, back, -0.8));
  const Hk0 = Lk, Hf0 = Lf;
  const keyCol = [1.0, 0.965, 0.92], KEY = 1.2;
  const fillCol = [0.86, 0.92, 1.0], FILL = 0.26;
  const rimCol = [1.0, 1.0, 1.0], RIM = 0.5;
  const sky = [0.25, 0.275, 0.32], ground = [0.13, 0.12, 0.11];
  const envSky = [0.85, 0.9, 1.0], envGround = [0.25, 0.23, 0.21];
  const alb = linHex(o.color);
  const lum = 0.2126 * alb[0] + 0.7152 * alb[1] + 0.0722 * alb[2];
  // Dark filament reads as glossier; light filament as matte satin.
  const specK = 0.22 + 0.18 * (1 - Math.min(1, lum * 2.5));
  const sheenK = 0.05 + 0.06 * (1 - Math.min(1, lum * 2.5));
  const envK = 0.55;

  // Layer-line pitch: keep stripes at least ~3 output pixels apart.
  const mmPerPx = dist / focal;
  const layerPitch = Math.max(0.2, 3.2 * mmPerPx);
  const layerK = o.layerLines ? 0.045 : 0;
  const twoPiOverPitch = (2 * Math.PI) / layerPitch;

  const ao = o.ao ? vertexAO(positions, indices, bb) : new Float32Array(nv).fill(1);

  // Contact shadow on the (invisible) floor, nudged away from the key light.
  if (o.shadow) {
    const sm = buildShadowMap(positions, indices, bb);
    const shadowOpacity = 0.8;
    const lh = Math.hypot(Lk[0], Lk[1]) || 1;
    const offX = -(Lk[0] / lh) * 0.06 * bb.size[2], offY = -(Lk[1] / lh) * 0.06 * bb.size[2];
    for (let y = 0; y < H; y++) {
      const ny = (ccy - (y + 0.5)) / focal;
      for (let x = 0; x < W; x++) {
        const nx = ((x + 0.5) - ccx) / focal;
        const dx = f[0] + nx * r[0] + ny * u[0];
        const dy = f[1] + nx * r[1] + ny * u[1];
        const dz = f[2] + nx * r[2] + ny * u[2];
        if (!(dz < -1e-6) || eye[2] <= sm.zFloor) continue;
        const tt = (sm.zFloor - eye[2]) / dz;
        const s = sampleShadow(sm, eye[0] + dx * tt - offX, eye[1] + dy * tt - offY);
        if (s <= 0) continue;
        const m = 1 - shadowOpacity * s;
        const k = (y * W + x) * 3;
        bgOut[k] *= m; bgOut[k + 1] *= m; bgOut[k + 2] *= Math.min(1, m * 1.015);
      }
    }
  }

  // ---- deferred shading ----
  for (let y = 0; y < Hs; y++) {
    const yc = y + 0.5;
    for (let x = 0; x < Ws; x++) {
      const idx = y * Ws + x;
      const k3 = idx * 3;
      const t = tbuf[idx];
      if (t < 0) {
        const b = (((y / S) | 0) * W + ((x / S) | 0)) * 3;
        accum[k3] = bgOut[b]; accum[k3 + 1] = bgOut[b + 1]; accum[k3 + 2] = bgOut[b + 2];
        continue;
      }
      const i0 = indices[t * 3], i1 = indices[t * 3 + 1], i2 = indices[t * 3 + 2];
      const x0 = SX[i0], y0 = SY[i0], x1 = SX[i1], y1 = SY[i1], x2 = SX[i2], y2 = SY[i2];
      const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
      const xc = x + 0.5;
      let w0 = ((x2 - x1) * (yc - y1) - (y2 - y1) * (xc - x1)) / area;
      let w1 = ((x0 - x2) * (yc - y2) - (y0 - y2) * (xc - x2)) / area;
      let w2 = 1 - w0 - w1;
      if (w0 < 0) w0 = 0; if (w1 < 0) w1 = 0; if (w2 < 0) w2 = 0;
      // perspective-correct weights
      let q0 = w0 * IZ[i0], q1 = w1 * IZ[i1], q2 = w2 * IZ[i2];
      const qs = q0 + q1 + q2 || 1;
      q0 /= qs; q1 /= qs; q2 /= qs;
      const o9 = t * 9;
      let nx = q0 * cn[o9] + q1 * cn[o9 + 3] + q2 * cn[o9 + 6];
      let nyy = q0 * cn[o9 + 1] + q1 * cn[o9 + 4] + q2 * cn[o9 + 7];
      let nz = q0 * cn[o9 + 2] + q1 * cn[o9 + 5] + q2 * cn[o9 + 8];
      const nl = Math.hypot(nx, nyy, nz) || 1;
      const sign = backFacing[t] ? -1 : 1; // a face seen from behind is lit from its other side
      nx = (nx / nl) * sign; nyy = (nyy / nl) * sign; nz = (nz / nl) * sign;
      const a3 = i0 * 3, b3 = i1 * 3, c3 = i2 * 3;
      const Px = q0 * positions[a3] + q1 * positions[b3] + q2 * positions[c3];
      const Py = q0 * positions[a3 + 1] + q1 * positions[b3 + 1] + q2 * positions[c3 + 1];
      const Pz = q0 * positions[a3 + 2] + q1 * positions[b3 + 2] + q2 * positions[c3 + 2];
      let vx = eye[0] - Px, vy = eye[1] - Py, vz = eye[2] - Pz;
      const vl = Math.hypot(vx, vy, vz) || 1;
      vx /= vl; vy /= vl; vz /= vl;

      const NV = Math.max(0, nx * vx + nyy * vy + nz * vz);
      const NLk = nx * Lk[0] + nyy * Lk[1] + nz * Lk[2];
      const NLf = nx * Lf[0] + nyy * Lf[1] + nz * Lf[2];
      const NLr = nx * Lr[0] + nyy * Lr[1] + nz * Lr[2];
      const wrap = 0.12;
      const occl = q0 * ao[i0] + q1 * ao[i1] + q2 * ao[i2];
      const dk = Math.max(0, (NLk + wrap) / (1 + wrap));
      const df = Math.max(0, (NLf + wrap) / (1 + wrap));
      const hemi = nz * 0.5 + 0.5;

      let layer = 1;
      if (layerK > 0) {
        const side = Math.sqrt(Math.max(0, 1 - nz * nz));
        layer = 1 - layerK * side * (0.5 + 0.5 * Math.cos(Pz * twoPiOverPitch));
      }

      // Blinn-Phong satin highlight from key and fill
      let hx = Hk0[0] + vx, hy = Hk0[1] + vy, hz = Hk0[2] + vz;
      let hl = Math.hypot(hx, hy, hz) || 1;
      const NHk = Math.max(0, (nx * hx + nyy * hy + nz * hz) / hl);
      hx = Hf0[0] + vx; hy = Hf0[1] + vy; hz = Hf0[2] + vz;
      hl = Math.hypot(hx, hy, hz) || 1;
      const NHf = Math.max(0, (nx * hx + nyy * hy + nz * hz) / hl);
      const nh2 = NHk * NHk, nh4 = nh2 * nh2, nh8 = nh4 * nh4, nh16 = nh8 * nh8, nh32 = nh16 * nh16;
      const specKey = (nh32 * nh16 * specK + nh8 * sheenK) * (NLk > 0 ? Math.min(1, NLk * 3) : 0);
      const f2 = NHf * NHf, f4 = f2 * f2, f8 = f4 * f4, f16 = f8 * f8;
      const specFill = f16 * f16 * specK * 0.35 * (NLf > 0 ? 1 : 0);

      // Fresnel-weighted environment reflection (bright sky above, warm floor below)
      const omv = 1 - NV, omv2 = omv * omv;
      const F = 0.04 + 0.96 * omv2 * omv2 * omv;
      const rz = 2 * NV * nz - vz;
      const eh = Math.max(0, Math.min(1, rz * 0.5 + 0.5));
      const envW = F * envK;

      const rim = Math.max(0, NLr) * omv2 * RIM;

      const aoKey = 0.6 + 0.4 * occl, aoFill = 0.3 + 0.7 * occl, aoAmb = occl * occl;
      for (let c = 0; c < 3; c++) {
        const ambient = (ground[c] + (sky[c] - ground[c]) * hemi) * aoAmb;
        const diffuse = alb[c] * (keyCol[c] * dk * KEY * aoKey + fillCol[c] * df * FILL * aoFill + ambient) * layer;
        const env = (envGround[c] + (envSky[c] - envGround[c]) * eh) * envW * aoFill;
        const col = diffuse + (keyCol[c] * specKey + fillCol[c] * specFill) * aoKey + env + rimCol[c] * rim * occl * (0.35 + 0.65 * alb[c]);
        accum[k3 + c] = tone(col);
      }
    }
  }
  return finish();
}

export function renderPNG(mesh, options = {}) {
  const { data, width, height } = renderRGBA(mesh, options);
  return encodePNG(data, width, height);
}

export const RENDER_VIEWS = Object.keys(VIEWS);
