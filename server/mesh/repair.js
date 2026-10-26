// Light automatic repair for AI-generated or uploaded meshes:
// weld duplicate vertices, drop degenerate and duplicate triangles, fill small holes,
// make triangles face outward, and put the model on the bed.

import { weld, orientOutward, placeOnBed, triNormalRaw, transform, computeBBox } from './core.js';
import { edgeTopology, overhangArea } from './analyze.js';

export function removeDegenerate(mesh, minArea = 1e-9) {
  const p = mesh.positions, ix = mesh.indices;
  const out = [];
  const seen = new Set();
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t], b = ix[t + 1], c = ix[t + 2];
    const n = triNormalRaw(p, a, b, c);
    if (Math.hypot(n[0], n[1], n[2]) / 2 < minArea) continue;
    const key = [a, b, c].sort((x, y) => x - y).join(',');
    if (seen.has(key)) continue; // duplicated face
    seen.add(key);
    out.push(a, b, c);
  }
  return { positions: mesh.positions, indices: Uint32Array.from(out) };
}

// Fill boundary loops (holes) with triangle fans around their centroid. Only loops up to
// `maxLoop` edges are filled, so a badly broken mesh is reported instead of silently "fixed".
export function fillHoles(mesh, maxLoop = 400) {
  const ix = mesh.indices;
  const directed = new Set();
  const nv = mesh.positions.length / 3;
  for (let t = 0; t < ix.length; t += 3) {
    for (let e = 0; e < 3; e++) directed.add(ix[t + e] * nv + ix[t + ((e + 1) % 3)]);
  }
  // A boundary edge a→b has no twin b→a. The hole loop runs the other way: b→a.
  const next = new Map();
  for (let t = 0; t < ix.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = ix[t + e], b = ix[t + ((e + 1) % 3)];
      if (!directed.has(b * nv + a)) {
        if (next.has(b)) return { mesh, filled: 0, complex: true }; // vertex on two holes: leave it
        next.set(b, a);
      }
    }
  }
  if (next.size === 0) return { mesh, filled: 0 };
  const positions = Array.from(mesh.positions);
  const indices = Array.from(ix);
  let filled = 0;
  const visited = new Set();
  for (const start of next.keys()) {
    if (visited.has(start)) continue;
    const loop = [];
    let v = start;
    while (!visited.has(v) && next.has(v) && loop.length <= maxLoop) {
      visited.add(v);
      loop.push(v);
      v = next.get(v);
    }
    if (v !== start || loop.length < 3 || loop.length > maxLoop) continue;
    let cx = 0, cy = 0, cz = 0;
    for (const i of loop) { cx += positions[i * 3]; cy += positions[i * 3 + 1]; cz += positions[i * 3 + 2]; }
    const c = positions.length / 3;
    positions.push(cx / loop.length, cy / loop.length, cz / loop.length);
    for (let k = 0; k < loop.length; k++) indices.push(loop[k], loop[(k + 1) % loop.length], c);
    filled++;
  }
  return { mesh: { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) }, filled };
}

// Area of downward faces touching the bed: a big flat base prints fast and sticks well.
function baseContact(mesh) {
  const p = mesh.positions, ix = mesh.indices;
  const minZ = computeBBox(mesh).min[2];
  let area = 0;
  for (let t = 0; t < ix.length; t += 3) {
    const n = triNormalRaw(p, ix[t], ix[t + 1], ix[t + 2]);
    const len = Math.hypot(n[0], n[1], n[2]);
    if (!len || n[2] / len > -0.95) continue;
    if (Math.max(p[ix[t] * 3 + 2], p[ix[t + 1] * 3 + 2], p[ix[t + 2] * 3 + 2]) - minZ > 0.3) continue;
    area += len / 2;
  }
  return area;
}

// Try the six "which side is down" orientations and keep the one that needs the least support
// (ties: the biggest flat base). Fewer supports = faster prints and cleaner surfaces.
export function autoOrient(mesh) {
  const rotations = [
    (x, y, z) => [x, y, z], (x, y, z) => [x, -y, -z],   // as is, upside down
    (x, y, z) => [x, -z, y], (x, y, z) => [x, z, -y],   // on its front / back
    (x, y, z) => [-z, y, x], (x, y, z) => [z, y, -x],   // on its sides
  ];
  let best = null;
  for (const r of rotations) {
    const m = placeOnBed(transform(mesh, r));
    const score = overhangArea(m) - baseContact(m) * 0.05;
    if (!best || score < best.score - 1e-6) best = { mesh: m, score };
  }
  return best.mesh;
}

export function repairMesh(mesh) {
  const report = { welded: false, filledHoles: 0, flipped: false };
  let m = weld(mesh, 1e-3);
  m = removeDegenerate(m);
  report.welded = true;
  const topo = edgeTopology(m);
  if (topo.boundaryEdges > 0 && topo.nonManifoldEdges === 0) {
    const r = fillHoles(m);
    m = r.mesh;
    report.filledHoles = r.filled;
  }
  const oriented = orientOutward(m);
  report.flipped = oriented !== m;
  return { mesh: placeOnBed(oriented), report };
}
