// Minimal PNG encoder (8-bit RGBA, adaptive per-row filtering). Node built-ins only.

import { Buffer } from 'node:buffer';
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf, start = 0, end = buf.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(data.buffer, data.byteOffset, data.length).copy(out, 8);
  out.writeUInt32BE(crc32(out, 4, 8 + data.length), 8 + data.length);
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Encode RGBA pixels as a PNG file.
 * @param {Uint8Array|Buffer} rgba width*height*4 bytes, row-major, top row first
 * @returns {Buffer}
 */
export function encodePNG(rgba, width, height) {
  width |= 0; height |= 0;
  if (width <= 0 || height <= 0) throw new Error('encodePNG: invalid size');
  if (rgba.length < width * height * 4) throw new Error('encodePNG: pixel buffer too small');
  const bpp = 4;
  const stride = width * bpp;
  const raw = Buffer.alloc((stride + 1) * height);
  const out = Buffer.alloc(stride);
  const mag = (v) => { v &= 0xff; return v < 128 ? v : 256 - v; };

  for (let y = 0; y < height; y++) {
    const row = y * stride;
    const prev = y > 0 ? row - stride : -1;
    // Score all five filters in one pass (sum of absolute residuals), keep the smallest.
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
    for (let i = 0; i < stride; i++) {
      const x = rgba[row + i];
      const a = i >= bpp ? rgba[row + i - bpp] : 0;
      const b = prev >= 0 ? rgba[prev + i] : 0;
      const c = prev >= 0 && i >= bpp ? rgba[prev + i - bpp] : 0;
      s0 += x < 128 ? x : 256 - x;
      s1 += mag(x - a);
      s2 += mag(x - b);
      s3 += mag(x - ((a + b) >> 1));
      s4 += mag(x - paeth(a, b, c));
    }
    let best = 0, bestSum = s0;
    if (s1 < bestSum) { best = 1; bestSum = s1; }
    if (s2 < bestSum) { best = 2; bestSum = s2; }
    if (s3 < bestSum) { best = 3; bestSum = s3; }
    if (s4 < bestSum) { best = 4; bestSum = s4; }
    for (let i = 0; i < stride; i++) {
      const x = rgba[row + i];
      const a = i >= bpp ? rgba[row + i - bpp] : 0;
      const b = prev >= 0 ? rgba[prev + i] : 0;
      const c = prev >= 0 && i >= bpp ? rgba[prev + i - bpp] : 0;
      let v;
      switch (best) {
        case 0: v = x; break;
        case 1: v = x - a; break;
        case 2: v = x - b; break;
        case 3: v = x - ((a + b) >> 1); break;
        default: v = x - paeth(a, b, c);
      }
      out[i] = v & 0xff;
    }
    const o = y * (stride + 1);
    raw[o] = best;
    out.copy(raw, o + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // no interlace

  const idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
