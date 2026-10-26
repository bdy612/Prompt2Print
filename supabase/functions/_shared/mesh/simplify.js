// Quadric edge-collapse mesh simplification (after Garland & Heckbert, in the iterative
// "fast quadric" style). Used to make the low-detail browser preview: the shape stays
// recognisable while fine detail is removed, and separate parts never get merged.

const symAdd = (a, b) => { const r = new Float64Array(10); for (let i = 0; i < 10; i++) r[i] = a[i] + b[i]; return r; };
const planeQ = (a, b, c, d) => Float64Array.of(a * a, a * b, a * c, a * d, b * b, b * c, b * d, c * c, c * d, d * d);
const det3 = (m, a11, a12, a13, a21, a22, a23, a31, a32, a33) =>
  m[a11] * m[a22] * m[a33] + m[a13] * m[a21] * m[a32] + m[a12] * m[a23] * m[a31]
  - m[a13] * m[a22] * m[a31] - m[a11] * m[a23] * m[a32] - m[a12] * m[a21] * m[a33];
const vertexError = (q, x, y, z) =>
  q[0] * x * x + 2 * q[1] * x * y + 2 * q[2] * x * z + 2 * q[3] * x + q[4] * y * y
  + 2 * q[5] * y * z + 2 * q[6] * y + q[7] * z * z + 2 * q[8] * z + q[9];

export function simplifyMesh(mesh, targetTriangles, aggressiveness = 7) {
  const P = mesh.positions, I = mesh.indices;
  const nv = P.length / 3;
  const verts = [];
  for (let i = 0; i < nv; i++) verts.push({ p: [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]], q: new Float64Array(10), tstart: 0, tcount: 0, border: false });
  const tris = [];
  for (let t = 0; t < I.length; t += 3) tris.push({ v: [I[t], I[t + 1], I[t + 2]], err: [0, 0, 0, 0], deleted: false, dirty: false, n: [0, 0, 0] });
  let refs = []; // { tid, tvertex }

  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; };
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  function calcError(i0, i1, out) {
    const q = symAdd(verts[i0].q, verts[i1].q);
    const border = verts[i0].border && verts[i1].border;
    const det = det3(q, 0, 1, 2, 1, 4, 5, 2, 5, 7);
    if (det !== 0 && !border) {
      out[0] = (-1 / det) * det3(q, 1, 2, 3, 4, 5, 6, 5, 7, 8);
      out[1] = (1 / det) * det3(q, 0, 2, 3, 1, 5, 6, 2, 7, 8);
      out[2] = (-1 / det) * det3(q, 0, 1, 3, 1, 4, 6, 2, 5, 8);
      return vertexError(q, out[0], out[1], out[2]);
    }
    const p1 = verts[i0].p, p2 = verts[i1].p;
    const p3 = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2, (p1[2] + p2[2]) / 2];
    const e1 = vertexError(q, ...p1), e2 = vertexError(q, ...p2), e3 = vertexError(q, ...p3);
    const e = Math.min(e1, e2, e3);
    const best = e === e1 ? p1 : e === e2 ? p2 : p3;
    out[0] = best[0]; out[1] = best[1]; out[2] = best[2];
    return e;
  }

  // Would collapsing i0 → p flip or squash any triangle around i0?
  function flipped(p, i1, v0, deleted) {
    for (let k = 0; k < v0.tcount; k++) {
      const r = refs[v0.tstart + k];
      const t = tris[r.tid];
      if (t.deleted) continue;
      const s = r.tvertex;
      const id1 = t.v[(s + 1) % 3], id2 = t.v[(s + 2) % 3];
      if (id1 === i1 || id2 === i1) { deleted[k] = 1; continue; }
      const d1 = norm(sub(verts[id1].p, p)), d2 = norm(sub(verts[id2].p, p));
      if (Math.abs(dot(d1, d2)) > 0.999) return true;
      const n = norm(cross(d1, d2));
      deleted[k] = 0;
      if (dot(n, t.n) < 0.2) return true;
    }
    return false;
  }

  let deletedCount = 0;
  function updateTriangles(i0, v, deleted) {
    const tmp = [0, 0, 0];
    for (let k = 0; k < v.tcount; k++) {
      const r = refs[v.tstart + k];
      const t = tris[r.tid];
      if (t.deleted) continue;
      if (deleted[k]) { t.deleted = true; deletedCount++; continue; }
      t.v[r.tvertex] = i0;
      t.dirty = true;
      t.err[0] = calcError(t.v[0], t.v[1], tmp);
      t.err[1] = calcError(t.v[1], t.v[2], tmp);
      t.err[2] = calcError(t.v[2], t.v[0], tmp);
      t.err[3] = Math.min(t.err[0], t.err[1], t.err[2]);
      refs.push(r);
    }
  }

  function updateMesh(iteration) {
    if (iteration > 0) {
      let dst = 0;
      for (const t of tris) if (!t.deleted) tris[dst++] = t;
      tris.length = dst;
    }
    for (const v of verts) { v.tstart = 0; v.tcount = 0; }
    for (const t of tris) for (const id of t.v) verts[id].tcount++;
    let tstart = 0;
    for (const v of verts) { v.tstart = tstart; tstart += v.tcount; v.tcount = 0; }
    refs = new Array(tris.length * 3);
    tris.forEach((t, i) => {
      for (let j = 0; j < 3; j++) {
        const v = verts[t.v[j]];
        refs[v.tstart + v.tcount] = { tid: i, tvertex: j };
        v.tcount++;
      }
    });
    if (iteration === 0) {
      // Border vertices (on open edges) are kept in place.
      for (const v of verts) v.border = false;
      verts.forEach((v) => {
        const counts = new Map();
        for (let k = 0; k < v.tcount; k++) {
          const t = tris[refs[v.tstart + k].tid];
          for (const id of t.v) counts.set(id, (counts.get(id) || 0) + 1);
        }
        for (const [id, c] of counts) if (c === 1) verts[id].border = true;
      });
      for (const t of tris) {
        const p0 = verts[t.v[0]].p, p1 = verts[t.v[1]].p, p2 = verts[t.v[2]].p;
        const n = norm(cross(sub(p1, p0), sub(p2, p0)));
        t.n = n;
        const q = planeQ(n[0], n[1], n[2], -dot(n, p0));
        for (const id of t.v) verts[id].q = symAdd(verts[id].q, q);
      }
      const tmp = [0, 0, 0];
      for (const t of tris) {
        for (let j = 0; j < 3; j++) t.err[j] = calcError(t.v[j], t.v[(j + 1) % 3], tmp);
        t.err[3] = Math.min(t.err[0], t.err[1], t.err[2]);
      }
    }
  }

  const start = tris.length;
  const p = [0, 0, 0];
  for (let iteration = 0; iteration < 100; iteration++) {
    if (start - deletedCount <= targetTriangles) break;
    if (iteration % 5 === 0) updateMesh(iteration);
    for (const t of tris) t.dirty = false;
    const threshold = 0.000000001 * (iteration + 3) ** aggressiveness;
    for (const t of tris) {
      if (t.err[3] > threshold || t.deleted || t.dirty) continue;
      for (let j = 0; j < 3; j++) {
        if (t.err[j] >= threshold) continue;
        const i0 = t.v[j], i1 = t.v[(j + 1) % 3];
        const v0 = verts[i0], v1 = verts[i1];
        if (v0.border !== v1.border) continue;
        calcError(i0, i1, p);
        const del0 = new Uint8Array(v0.tcount), del1 = new Uint8Array(v1.tcount);
        if (flipped(p, i1, v0, del0) || flipped(p, i0, v1, del1)) continue;
        // Recompute normals for the surviving neighbours later via t.n of the moved faces.
        v0.p = [p[0], p[1], p[2]];
        v0.q = symAdd(v1.q, v0.q);
        const tstart = refs.length;
        updateTriangles(i0, v0, del0);
        updateTriangles(i0, v1, del1);
        const tcount = refs.length - tstart;
        if (tcount <= v0.tcount) {
          for (let k = 0; k < tcount; k++) refs[v0.tstart + k] = refs[tstart + k];
        } else {
          v0.tstart = tstart;
        }
        v0.tcount = tcount;
        break;
      }
      if (start - deletedCount <= targetTriangles) break;
    }
    // Refresh face normals of moved triangles so later flip tests stay accurate.
    for (const t of tris) {
      if (t.deleted || !t.dirty) continue;
      const p0 = verts[t.v[0]].p, p1 = verts[t.v[1]].p, p2 = verts[t.v[2]].p;
      t.n = norm(cross(sub(p1, p0), sub(p2, p0)));
    }
  }

  // Compact into an indexed mesh.
  const remap = new Int32Array(nv).fill(-1);
  const outP = [];
  const outI = [];
  for (const t of tris) {
    if (t.deleted) continue;
    for (const id of t.v) {
      if (remap[id] < 0) { remap[id] = outP.length / 3; outP.push(...verts[id].p); }
      outI.push(remap[id]);
    }
  }
  return { positions: Float32Array.from(outP), indices: Uint32Array.from(outI) };
}
