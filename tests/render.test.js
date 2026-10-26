// Tests for the software renderer and PNG encoder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { renderPNG, renderRGBA } from '../server/mesh/render.js';
import { encodePNG, crc32 } from '../server/mesh/png.js';

function box(sx = 40, sy = 30, sz = 20) {
  const x = sx / 2, y = sy / 2;
  const p = [-x, -y, 0, x, -y, 0, x, y, 0, -x, y, 0, -x, -y, sz, x, -y, sz, x, y, sz, -x, y, sz];
  const i = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return { positions: Float32Array.from(p), indices: Uint32Array.from(i) };
}

function icosphere(radius = 25, subdivisions = 3) {
  const t = (1 + Math.sqrt(5)) / 2;
  let verts = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
  let faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  verts = verts.map((v) => { const l = Math.hypot(...v); return v.map((c) => c / l); });
  for (let s = 0; s < subdivisions; s++) {
    const cache = new Map();
    const mid = (a, b) => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (!cache.has(key)) {
        const m = verts[a].map((c, k) => (c + verts[b][k]) / 2);
        const l = Math.hypot(...m);
        verts.push(m.map((c) => c / l));
        cache.set(key, verts.length - 1);
      }
      return cache.get(key);
    };
    faces = faces.flatMap(([a, b, c]) => { const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a); return [[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]]; });
  }
  return {
    positions: Float32Array.from(verts.flatMap(([x, y, z]) => [x * radius, y * radius, z * radius + radius])),
    indices: Uint32Array.from(faces.flat()),
  };
}

function uvSphere(r, seg, rings) {
  const p = [0, 0, 0], idx = [];
  for (let j = 1; j < rings; j++) {
    const th = (Math.PI * j) / rings;
    for (let i = 0; i < seg; i++) {
      const ph = (2 * Math.PI * i) / seg;
      p.push(r * Math.sin(th) * Math.cos(ph), r * Math.sin(th) * Math.sin(ph), r - r * Math.cos(th));
    }
  }
  p.push(0, 0, 2 * r);
  const top = p.length / 3 - 1;
  const ring = (j, i) => 1 + (j - 1) * seg + (i % seg);
  for (let i = 0; i < seg; i++) idx.push(0, ring(1, i + 1), ring(1, i));
  for (let j = 1; j < rings - 1; j++) for (let i = 0; i < seg; i++) {
    idx.push(ring(j, i), ring(j, i + 1), ring(j + 1, i + 1), ring(j, i), ring(j + 1, i + 1), ring(j + 1, i));
  }
  for (let i = 0; i < seg; i++) idx.push(ring(rings - 1, i), ring(rings - 1, i + 1), top);
  return { positions: Float32Array.from(p), indices: Uint32Array.from(idx) };
}

// Decode our own PNG output (8-bit RGBA, any filter type) back to raw pixels.
function decodePNG(buf) {
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG signature');
  let off = 8, width = 0, height = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    assert.equal(buf.readUInt32BE(off + 8 + len), crc32(buf, off + 4, off + 8 + len), `CRC of ${type}`);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      assert.equal(data[8], 8, 'bit depth'); assert.equal(data[9], 6, 'colour type RGBA');
    }
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
    if (type === 'IEND') break;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i];
      const a = i >= 4 ? px[y * stride + i - 4] : 0;
      const b = y > 0 ? px[(y - 1) * stride + i] : 0;
      const c = y > 0 && i >= 4 ? px[(y - 1) * stride + i - 4] : 0;
      let v;
      if (f === 0) v = x;
      else if (f === 1) v = x + a;
      else if (f === 2) v = x + b;
      else if (f === 3) v = x + ((a + b) >> 1);
      else { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      px[y * stride + i] = v & 0xff;
    }
  }
  return { width, height, px };
}

const pixel = (img, x, y) => [...img.px.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];
const close = (a, b, tol) => a.slice(0, 3).every((v, i) => Math.abs(v - b[i]) <= tol);

test('encodePNG round-trips arbitrary pixels', () => {
  const w = 7, h = 5, rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 37 + (i >> 3) * 11) & 255;
  const img = decodePNG(encodePNG(rgba, w, h));
  assert.equal(img.width, w); assert.equal(img.height, h);
  assert.deepEqual([...img.px], [...rgba]);
});

for (const [name, mesh] of [['box', box()], ['icosphere', icosphere()]]) {
  test(`renders a ${name} as a valid PNG with the model in the middle`, () => {
    const W = 200, H = 160;
    const png = renderPNG(mesh, { width: W, height: H, color: '#D6246E', background: ['#F4F5F3', '#E3E6E8'] });
    const img = decodePNG(png);
    assert.equal(img.width, W); assert.equal(img.height, H);
    const top = [0xf4, 0xf5, 0xf3], bottom = [0xe3, 0xe6, 0xe8];
    assert.ok(close(pixel(img, 0, 0), top, 2), `top-left ${pixel(img, 0, 0)}`);
    assert.ok(close(pixel(img, W - 1, 0), top, 2), `top-right ${pixel(img, W - 1, 0)}`);
    assert.ok(close(pixel(img, 0, H - 1), bottom, 2), `bottom-left ${pixel(img, 0, H - 1)}`);
    assert.ok(close(pixel(img, W - 1, H - 1), bottom, 2), `bottom-right ${pixel(img, W - 1, H - 1)}`);
    const c = pixel(img, W >> 1, H >> 1);
    const midBg = top.map((v, i) => (v + bottom[i]) / 2);
    assert.ok(!close(c, midBg, 20), `centre pixel ${c} should not be background`);
    assert.ok(c[0] > c[1] + 30, `centre pixel ${c} should be magenta-ish`);
    assert.equal(c[3], 255);
  });
}

test('every view renders and a single-colour background works', () => {
  for (const view of ['iso', 'hero', 'front', 'side', 'top']) {
    const { data, width, height } = renderRGBA(icosphere(20, 2), { width: 64, height: 64, view, background: '#FFFFFF' });
    assert.equal(data.length, width * height * 4);
    assert.deepEqual([...data.subarray(0, 4)], [255, 255, 255, 255], `${view} corner`);
  }
});

test('empty mesh renders background only', () => {
  const img = decodePNG(renderPNG({ positions: new Float32Array(0), indices: new Uint32Array(0) }, { width: 10, height: 10, background: '#336699' }));
  assert.ok(close(pixel(img, 5, 5), [0x33, 0x66, 0x99], 1));
});

test('renders a ~60k-triangle sphere at 640x640 quickly', () => {
  const mesh = uvSphere(30, 250, 121);
  const tris = mesh.indices.length / 3;
  assert.ok(tris > 55000 && tris < 65000, `triangles ${tris}`);
  renderPNG(mesh, { width: 160, height: 160 }); // warm up the JIT
  const t0 = performance.now();
  const png = renderPNG(mesh, { width: 640, height: 640, supersample: 2 });
  const ms = performance.now() - t0;
  console.log(`  60k triangles @ 640x640 x2 supersample: ${ms.toFixed(0)} ms, ${(png.length / 1024).toFixed(0)} KB`);
  assert.ok(ms < 2500, `took ${ms.toFixed(0)} ms`);
});
