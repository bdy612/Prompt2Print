// Core mesh utilities.
// A mesh is { positions: Float32Array (x,y,z per vertex), indices: Uint32Array (3 per triangle) }.
// Units are millimetres, Z is up, triangles wind counter-clockwise when seen from outside.

export function createMesh(positions, indices) {
  return {
    positions: positions instanceof Float32Array ? positions : Float32Array.from(positions),
    indices: indices instanceof Uint32Array ? indices : Uint32Array.from(indices),
  };
}

export function triangleCount(mesh) { return mesh.indices.length / 3; }
export function vertexCount(mesh) { return mesh.positions.length / 3; }

// Merge vertices that sit at (almost) the same position. Turns STL triangle soup into an indexed mesh.
export function weld(mesh, tolerance = 1e-4) {
  const { positions, indices } = mesh;
  const inv = 1 / tolerance;
  const map = new Map();
  const remap = new Uint32Array(positions.length / 3);
  const out = [];
  for (let i = 0; i < positions.length / 3; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    const key = `${Math.round(x * inv)},${Math.round(y * inv)},${Math.round(z * inv)}`;
    let idx = map.get(key);
    if (idx === undefined) {
      idx = out.length / 3;
      out.push(x, y, z);
      map.set(key, idx);
    }
    remap[i] = idx;
  }
  const newIdx = [];
  for (let t = 0; t < indices.length; t += 3) {
    const a = remap[indices[t]], b = remap[indices[t + 1]], c = remap[indices[t + 2]];
    if (a !== b && b !== c && a !== c) newIdx.push(a, b, c);
  }
  return createMesh(out, newIdx);
}

export function fromTriangleSoup(soup /* 9 floats per triangle */) {
  const n = soup.length / 3;
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  return weld(createMesh(soup, idx));
}

export function computeBBox(mesh) {
  const p = mesh.positions;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = p[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  if (p.length === 0) return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0] };
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

// Signed volume (mm³) via the divergence theorem; positive when triangles face outward.
export function signedVolume(mesh) {
  const p = mesh.positions, ix = mesh.indices;
  let v = 0;
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
    const ax = p[a], ay = p[a + 1], az = p[a + 2];
    const bx = p[b], by = p[b + 1], bz = p[b + 2];
    const cx = p[c], cy = p[c + 1], cz = p[c + 2];
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v / 6;
}

export function surfaceArea(mesh) {
  const p = mesh.positions, ix = mesh.indices;
  let area = 0;
  for (let t = 0; t < ix.length; t += 3) {
    const n = triNormalRaw(p, ix[t], ix[t + 1], ix[t + 2]);
    area += Math.hypot(n[0], n[1], n[2]) / 2;
  }
  return area;
}

// Unnormalised normal (length = 2 × triangle area).
export function triNormalRaw(p, ia, ib, ic) {
  const a = ia * 3, b = ib * 3, c = ic * 3;
  const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
  const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

export function transform(mesh, fn /* (x,y,z) => [x,y,z] */) {
  const p = new Float32Array(mesh.positions.length);
  for (let i = 0; i < p.length; i += 3) {
    const r = fn(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]);
    p[i] = r[0]; p[i + 1] = r[1]; p[i + 2] = r[2];
  }
  return { positions: p, indices: mesh.indices };
}

export function scaleMesh(mesh, sx, sy = sx, sz = sx) {
  const m = transform(mesh, (x, y, z) => [x * sx, y * sy, z * sz]);
  // A negative scale count flips orientation; fix winding so normals stay outward.
  return (sx * sy * sz < 0) ? flipWinding(m) : m;
}

export function translateMesh(mesh, dx, dy, dz) {
  return transform(mesh, (x, y, z) => [x + dx, y + dy, z + dz]);
}

export function rotateZ(mesh, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return transform(mesh, (x, y, z) => [x * c - y * s, x * s + y * c, z]);
}

// Rotate so the model's "up" axis (Y-up formats like glTF) becomes Z-up.
export function yUpToZUp(mesh) {
  return transform(mesh, (x, y, z) => [x, -z, y]);
}

export function flipWinding(mesh) {
  const ix = new Uint32Array(mesh.indices);
  for (let t = 0; t < ix.length; t += 3) { const tmp = ix[t + 1]; ix[t + 1] = ix[t + 2]; ix[t + 2] = tmp; }
  return { positions: mesh.positions, indices: ix };
}

export function mergeMeshes(meshes) {
  let vCount = 0, iCount = 0;
  for (const m of meshes) { vCount += m.positions.length; iCount += m.indices.length; }
  const positions = new Float32Array(vCount);
  const indices = new Uint32Array(iCount);
  let vo = 0, io = 0;
  for (const m of meshes) {
    positions.set(m.positions, vo);
    const base = vo / 3;
    for (let i = 0; i < m.indices.length; i++) indices[io + i] = m.indices[i] + base;
    vo += m.positions.length;
    io += m.indices.length;
  }
  return { positions, indices };
}

// Centre on X/Y and rest the lowest point on the bed (z = 0).
export function placeOnBed(mesh) {
  const bb = computeBBox(mesh);
  const cx = (bb.min[0] + bb.max[0]) / 2, cy = (bb.min[1] + bb.max[1]) / 2;
  return translateMesh(mesh, -cx, -cy, -bb.min[2]);
}

// Make sure the mesh faces outward (positive volume).
export function orientOutward(mesh) {
  return signedVolume(mesh) < 0 ? flipWinding(mesh) : mesh;
}

// Scale uniformly so the largest dimension equals `targetMm`.
export function fitToSize(mesh, targetMm) {
  const bb = computeBBox(mesh);
  const largest = Math.max(...bb.size) || 1;
  return scaleMesh(mesh, targetMm / largest);
}
