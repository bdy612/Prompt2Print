// Reading and writing 3D files on the server: STL (binary and ASCII), OBJ and GLB (glTF binary).
// These files only ever live in the private models folder; they are never sent to browsers.

import { createMesh, fromTriangleSoup, weld, mergeMeshes, yUpToZUp } from './core.js';

// STL ------------------------------------------------------------------------------------------
export function parseSTL(buf) {
  if (buf.length >= 84) {
    const count = buf.readUInt32LE(80);
    if (84 + count * 50 === buf.length) return parseBinarySTL(buf, count);
  }
  const head = buf.subarray(0, Math.min(buf.length, 1024)).toString('latin1');
  if (/^\s*solid/.test(head) && /facet|vertex/.test(buf.toString('latin1', 0, Math.min(buf.length, 4096)))) {
    return parseAsciiSTL(buf.toString('latin1'));
  }
  if (buf.length >= 84) return parseBinarySTL(buf, Math.floor((buf.length - 84) / 50));
  throw new Error('Not an STL file');
}

function parseBinarySTL(buf, count) {
  const soup = new Float32Array(count * 9);
  let o = 84;
  for (let i = 0; i < count; i++) {
    o += 12; // skip the stored normal
    for (let k = 0; k < 9; k++) { soup[i * 9 + k] = buf.readFloatLE(o); o += 4; }
    o += 2;
  }
  return fromTriangleSoup(soup);
}

function parseAsciiSTL(text) {
  const nums = [];
  const rx = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g;
  let m;
  while ((m = rx.exec(text))) nums.push(+m[1], +m[2], +m[3]);
  return fromTriangleSoup(Float32Array.from(nums));
}

export function writeBinarySTL(mesh, header = 'Prompt2Print private model') {
  const { positions: p, indices: ix } = mesh;
  const n = ix.length / 3;
  const buf = Buffer.alloc(84 + n * 50);
  buf.write(header.slice(0, 79), 0, 'latin1');
  buf.writeUInt32LE(n, 80);
  let o = 84;
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    buf.writeFloatLE(nx, o); buf.writeFloatLE(ny, o + 4); buf.writeFloatLE(nz, o + 8); o += 12;
    for (const v of [a, b, c]) {
      buf.writeFloatLE(p[v], o); buf.writeFloatLE(p[v + 1], o + 4); buf.writeFloatLE(p[v + 2], o + 8); o += 12;
    }
    o += 2;
  }
  return buf;
}

// OBJ ------------------------------------------------------------------------------------------
export function parseOBJ(text) {
  const verts = [];
  const idx = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('v ')) {
      const [, x, y, z] = line.trim().split(/\s+/);
      verts.push(+x, +y, +z);
    } else if (line.startsWith('f ')) {
      const parts = line.trim().split(/\s+/).slice(1).map((s) => {
        const i = parseInt(s.split('/')[0], 10);
        return i < 0 ? verts.length / 3 + i : i - 1;
      });
      for (let k = 1; k + 1 < parts.length; k++) idx.push(parts[0], parts[k], parts[k + 1]);
    }
  }
  // OBJ files from AI tools are Y-up.
  return weld(yUpToZUp(createMesh(verts, idx)));
}

// GLB (glTF 2.0 binary) --------------------------------------------------------------------------
const COMPONENT = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

export function parseGLB(buf) {
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('Not a GLB file');
  let o = 12;
  let json = null;
  let bin = null;
  while (o < buf.length) {
    const len = buf.readUInt32LE(o);
    const type = buf.readUInt32LE(o + 4);
    const chunk = buf.subarray(o + 8, o + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(chunk.toString('utf8'));
    else if (type === 0x004e4942) bin = chunk;
    o += 8 + len;
  }
  if (!json) throw new Error('GLB has no JSON chunk');
  const used = json.extensionsUsed || [];
  if (used.includes('KHR_draco_mesh_compression') || used.includes('EXT_meshopt_compression')) {
    throw new Error('Compressed GLB (Draco/meshopt) is not supported; request an uncompressed GLB or STL from the provider.');
  }

  const readAccessor = (index) => {
    const acc = json.accessors[index];
    const view = json.bufferViews[acc.bufferView];
    const Type = COMPONENT[acc.componentType];
    const comps = SIZE[acc.type];
    const start = (view.byteOffset || 0) + (acc.byteOffset || 0);
    const stride = view.byteStride || comps * Type.BYTES_PER_ELEMENT;
    const out = new Float64Array(acc.count * comps);
    const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
    const get = {
      5120: (p) => dv.getInt8(p), 5121: (p) => dv.getUint8(p), 5122: (p) => dv.getInt16(p, true),
      5123: (p) => dv.getUint16(p, true), 5125: (p) => dv.getUint32(p, true), 5126: (p) => dv.getFloat32(p, true),
    }[acc.componentType];
    for (let i = 0; i < acc.count; i++) {
      for (let c = 0; c < comps; c++) out[i * comps + c] = get(start + i * stride + c * Type.BYTES_PER_ELEMENT);
    }
    return out;
  };

  const meshes = [];
  const visit = (nodeIndex, parent) => {
    const node = json.nodes[nodeIndex];
    const local = nodeMatrix(node);
    const world = mul4(parent, local);
    if (node.mesh !== undefined) {
      for (const prim of json.meshes[node.mesh].primitives) {
        if (prim.mode !== undefined && prim.mode !== 4) continue; // triangles only
        const pos = readAccessor(prim.attributes.POSITION);
        const n = pos.length / 3;
        const positions = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
          const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
          positions[i * 3] = world[0] * x + world[4] * y + world[8] * z + world[12];
          positions[i * 3 + 1] = world[1] * x + world[5] * y + world[9] * z + world[13];
          positions[i * 3 + 2] = world[2] * x + world[6] * y + world[10] * z + world[14];
        }
        let indices;
        if (prim.indices !== undefined) indices = Uint32Array.from(readAccessor(prim.indices));
        else { indices = new Uint32Array(n); for (let i = 0; i < n; i++) indices[i] = i; }
        meshes.push(createMesh(positions, indices));
      }
    }
    for (const child of node.children || []) visit(child, world);
  };
  const scene = json.scenes?.[json.scene ?? 0];
  const roots = scene ? scene.nodes : json.nodes.map((_, i) => i);
  for (const r of roots) visit(r, IDENTITY);
  if (!meshes.length) throw new Error('GLB contains no triangle meshes');
  return weld(yUpToZUp(mergeMeshes(meshes)));
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function nodeMatrix(node) {
  if (node.matrix) return node.matrix;
  const [tx, ty, tz] = node.translation || [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale || [1, 1, 1];
  const xx = qx * qx, yy = qy * qy, zz = qz * qz, xy = qx * qy, xz = qx * qz, yz = qy * qz, wx = qw * qx, wy = qw * qy, wz = qw * qz;
  return [
    (1 - 2 * (yy + zz)) * sx, 2 * (xy + wz) * sx, 2 * (xz - wy) * sx, 0,
    2 * (xy - wz) * sy, (1 - 2 * (xx + zz)) * sy, 2 * (yz + wx) * sy, 0,
    2 * (xz + wy) * sz, 2 * (yz - wx) * sz, (1 - 2 * (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

function mul4(a, b) {
  const out = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

export function parseAny(buf, hint = '') {
  const h = hint.toLowerCase();
  if (h.endsWith('.glb') || buf.readUInt32LE(0) === 0x46546c67) return parseGLB(buf);
  if (h.endsWith('.obj')) return parseOBJ(buf.toString('utf8'));
  return parseSTL(buf);
}
