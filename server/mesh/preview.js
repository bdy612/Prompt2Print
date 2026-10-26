// Protected preview meshes for the browser's 3D viewer.
//
// The original model never leaves the server. Browsers get a reduced copy:
//  • simplified by quadric edge collapse (fine detail is removed, the overall shape stays),
//  • capped at a triangle budget,
//  • positions quantised to 11 bits,
//  • packed in a custom binary layout (not STL/OBJ/GLB), served with no-store headers to the
//    owner only.
// Anything a browser can display can in principle be captured, so the real protection is that the
// printable full-resolution file is never sent.

import { computeBBox } from './core.js';
import { simplifyMesh } from './simplify.js';

// Reduce to at most ~40% of the original triangles (capped), with quadric edge collapse.
export function buildPreview(mesh, { maxTriangles = 12000, keep = 0.4 } = {}) {
  const n = mesh.indices.length / 3;
  const target = Math.min(maxTriangles, Math.max(600, Math.round(n * keep)));
  return n <= target ? mesh : simplifyMesh(mesh, target);
}

const BITS = 11;
const QMAX = (1 << BITS) - 1;

export function encodePreview(mesh) {
  const bb = computeBBox(mesh);
  const nv = mesh.positions.length / 3;
  const nt = mesh.indices.length / 3;
  const wide = nv > 65535;
  const headerBytes = 4 + 4 + 4 + 4 + 24;
  const posBytes = nv * 6;
  const pad = (4 - ((headerBytes + posBytes) % 4)) % 4;
  const idxBytes = nt * 3 * (wide ? 4 : 2);
  const buf = Buffer.alloc(headerBytes + posBytes + pad + idxBytes);
  buf.write('P2PV', 0, 'latin1');
  buf.writeUInt32LE(wide ? 2 : 1, 4);
  buf.writeUInt32LE(nv, 8);
  buf.writeUInt32LE(nt, 12);
  for (let k = 0; k < 3; k++) {
    buf.writeFloatLE(bb.min[k], 16 + k * 4);
    buf.writeFloatLE(bb.size[k] || 1, 28 + k * 4);
  }
  let o = headerBytes;
  for (let i = 0; i < nv; i++) {
    for (let k = 0; k < 3; k++) {
      const v = (mesh.positions[i * 3 + k] - bb.min[k]) / (bb.size[k] || 1);
      buf.writeUInt16LE(Math.round(Math.min(1, Math.max(0, v)) * QMAX), o);
      o += 2;
    }
  }
  o += pad;
  for (let i = 0; i < mesh.indices.length; i++) {
    if (wide) { buf.writeUInt32LE(mesh.indices[i], o); o += 4; } else { buf.writeUInt16LE(mesh.indices[i], o); o += 2; }
  }
  return buf;
}

export const PREVIEW_QMAX = QMAX;
