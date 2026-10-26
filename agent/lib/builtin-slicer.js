// Prompt2Print built-in slicer.
//
// A small, dependency-free FDM slicer used when no external slicer (PrusaSlicer / OrcaSlicer /
// CuraEngine) is configured. It produces real, valid G-code — perimeters, rectilinear infill,
// solid top/bottom skins and optional grid supports — good enough for testing and simple parts.
// For production quality, configure an external slicer; see server/printing/slicer.js.
//
// Pipeline
//   1. Centre the (already scaled) mesh on the bed and drop it to z = 0.
//   2. Cut it at every layer's mid-height into closed contours (slicer/contours.js).
//   3. Group contours into islands by even-odd nesting; outer contours CCW, holes CW, so the
//      material is always to the left of travel.
//   4. Walls: `wallLoops` perimeters, each offset toward the material (miter offset).
//   5. Infill: scanlines at 45°/−45° (alternating per layer) on a global grid with solid
//      spacing (= line width). For layer i, the part of the infill area that is not covered by
//      ALL of the `bottomLayers` layers below and the `topLayers` layers above is printed solid
//      (every scanline); the covered part is sparse (every m-th scanline, m = 100 / infill%).
//      This gives correct solid floors, roofs and top surfaces of steps without polygon booleans.
//   6. Optional supports: grid columns under steep downward faces (slicer/supports.js).
//   7. Emit G-code (absolute XYZ, relative E) with time / filament estimates.

import { sliceContours, buildIslands } from './slicer/contours.js';
import {
  offsetLeft, polyArea, pointInPolygon, prepareEdges, scanIntervals,
  intersectIntervals, subtractIntervals,
} from './slicer/geometry.js';
import { computeSupports } from './slicer/supports.js';

const DEFAULTS = {
  layerHeight: 0.2,
  firstLayerHeight: 0.2,
  lineWidth: 0.42,
  wallLoops: 2,
  infillPercent: 20,
  topLayers: 4,
  bottomLayers: 3,
  supports: false,
  printSpeed: 60,
  wallSpeed: 40,
  firstLayerSpeed: 25,
  travelSpeed: 150,
  retractMm: 0.8,
  retractSpeed: 35,
  material: { code: 'PLA', nozzleTemp: 210, bedTemp: 60, densityGcm3: 1.24, filamentDiameterMm: 1.75, fanPercent: 100 },
  printer: { name: 'Generic', bed: { x: 220, y: 220, z: 250 }, flavor: 'marlin' },
  jobName: 'job',
};

export const SLICER_DEFAULTS = DEFAULTS;

function normalizeSettings(input = {}) {
  const s = { ...DEFAULTS, ...input };
  s.material = { ...DEFAULTS.material, ...(input.material || {}) };
  s.printer = { ...DEFAULTS.printer, ...(input.printer || {}) };
  s.printer.bed = { ...DEFAULTS.printer.bed, ...((input.printer && input.printer.bed) || {}) };
  s.printer.flavor = String(s.printer.flavor || 'marlin').toLowerCase();
  if (!['marlin', 'klipper', 'bambu'].includes(s.printer.flavor)) s.printer.flavor = 'marlin';
  s.infillPercent = Math.max(0, Math.min(100, Number(s.infillPercent) || 0));
  s.wallLoops = Math.max(1, Math.min(10, Math.round(Number(s.wallLoops) || 1)));
  s.topLayers = Math.max(0, Math.round(Number(s.topLayers) || 0));
  s.bottomLayers = Math.max(0, Math.round(Number(s.bottomLayers) || 0));
  for (const k of ['layerHeight', 'firstLayerHeight', 'lineWidth', 'printSpeed', 'wallSpeed', 'firstLayerSpeed', 'travelSpeed', 'retractSpeed']) {
    const v = Number(s[k]);
    if (!(v > 0)) s[k] = DEFAULTS[k]; else s[k] = v;
  }
  s.retractMm = Math.max(0, Number(s.retractMm) || 0);
  s.jobName = String(s.jobName || 'job').replace(/[\r\n;]+/g, ' ').slice(0, 120);
  return s;
}

const num = (v, d = 3) => String(+v.toFixed(d));

/**
 * Slice a mesh into G-code.
 * @param {{positions: Float32Array, indices: Uint32Array}} mesh already scaled, mm, Z-up
 * @param {object} settings see DEFAULTS
 * @returns {{gcode: string, stats: {layers, layerHeight, filamentLengthMm, filamentGrams, printTimeSec, sizeMm, warnings}}}
 */
export function sliceMesh(mesh, settings = {}) {
  const s = normalizeSettings(settings);
  if (!mesh || !mesh.positions || !mesh.indices || mesh.indices.length < 3) throw new Error('Cannot slice an empty mesh');
  const warnings = [];
  const bed = s.printer.bed;
  const lw = s.lineWidth;

  // ---- 1. place on bed ----------------------------------------------------------------------
  const src = mesh.positions;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < src.length; i += 3) {
    const x = src[i], y = src[i + 1], z = src[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const size = [maxX - minX, maxY - minY, maxZ - minZ];
  const dx = bed.x / 2 - (minX + maxX) / 2, dy = bed.y / 2 - (minY + maxY) / 2, dz = -minZ;
  const pos = new Float64Array(src.length);
  for (let i = 0; i < src.length; i += 3) { pos[i] = src[i] + dx; pos[i + 1] = src[i + 1] + dy; pos[i + 2] = src[i + 2] + dz; }
  const placed = { minX: minX + dx, maxX: maxX + dx, minY: minY + dy, maxY: maxY + dy };
  if (size[0] > bed.x || size[1] > bed.y) warnings.push(`Model footprint ${num(size[0], 1)}×${num(size[1], 1)} mm is larger than the ${bed.x}×${bed.y} mm bed`);
  if (size[2] > bed.z) warnings.push(`Model height ${num(size[2], 1)} mm exceeds the printer's ${bed.z} mm build height`);

  // ---- 2. layers ----------------------------------------------------------------------------
  const height = size[2];
  const lh = s.layerHeight, flh = s.firstLayerHeight;
  const planes = [], tops = [], heights = [];
  for (let i = 0; ; i++) {
    const top = i === 0 ? flh : flh + i * lh;
    const h = i === 0 ? flh : lh;
    const plane = top - h / 2;
    if (plane >= height - 1e-6 && i > 0) break;
    if (i === 0 && height <= 1e-6) break;
    planes.push(Math.min(plane, height - 1e-4));
    tops.push(top);
    heights.push(h);
    if (i > 100000) break;
  }
  const L = planes.length;
  if (L === 0) throw new Error('Model is too thin to slice');

  const { layers: contourLayers, openChains } = sliceContours(pos, mesh.indices, planes, { closeGap: 2 * lw });
  if (openChains > 0) warnings.push(`${openChains} open contour(s) skipped — the mesh is not watertight`);

  // ---- 3/4. islands, walls, infill boundaries ---------------------------------------------------
  const layerOutlines = new Array(L);
  const layerIslands = new Array(L);
  let thinWallLayers = 0;
  for (let i = 0; i < L; i++) {
    const { islands, outlines } = buildIslands(contourLayers[i]);
    layerOutlines[i] = outlines;
    const out = [];
    for (const isl of islands) {
      const walls = [];
      let complete = true;
      for (let k = 0; k < s.wallLoops; k++) {
        const level = offsetIsland(isl, lw * (k + 0.5));
        if (!level) { complete = false; break; }
        walls.push(level);
      }
      let boundary = null;
      if (complete) boundary = offsetIsland(isl, lw * s.wallLoops - 0.15 * lw);
      if (!complete || !boundary) thinWallLayers++;
      out.push({ walls, boundary, start: isl.outer });
    }
    layerIslands[i] = out;
  }
  if (thinWallLayers > 0) warnings.push(`${thinWallLayers} island-layer(s) are thinner than ${s.wallLoops} walls; printed with fewer perimeters`);

  // ---- 5. infill ----------------------------------------------------------------------------
  const solidSpacing = lw;
  const sparseEvery = s.infillPercent <= 0 ? Infinity : Math.max(1, Math.round(100 / s.infillPercent));
  const outlinePrep = new Map();
  const prepOutline = (j, sign) => {
    const key = j * 2 + (sign > 0 ? 0 : 1);
    let v = outlinePrep.get(key);
    if (!v) { v = prepareEdges(layerOutlines[j], (sign * Math.PI) / 4); outlinePrep.set(key, v); }
    return v;
  };
  const layerInfill = new Array(L);
  for (let i = 0; i < L; i++) {
    // free cached outline edges that can no longer be needed
    const stale = i - s.bottomLayers - 1;
    if (stale >= 0) { outlinePrep.delete(stale * 2); outlinePrep.delete(stale * 2 + 1); }

    const boundaryLoops = [];
    for (const isl of layerIslands[i]) if (isl.boundary) boundaryLoops.push(...isl.boundary);
    if (!boundaryLoops.length) { layerInfill[i] = []; continue; }
    const sign = i % 2 === 0 ? 1 : -1;
    const angle = (sign * Math.PI) / 4;
    const prep = prepareEdges(boundaryLoops, angle);
    const k0 = Math.ceil(prep.ymin / solidSpacing - 0.5), k1 = Math.floor(prep.ymax / solidSpacing - 0.5);
    if (k1 < k0) { layerInfill[i] = []; continue; }
    const ys = [];
    for (let k = k0; k <= k1; k++) ys.push((k + 0.5) * solidSpacing);
    const S = scanIntervals(prep, ys);

    const wholeSolid = i < s.bottomLayers || i >= L - s.topLayers;
    let C = null;
    if (!wholeSolid) {
      const neighbors = [];
      for (let j = i - s.bottomLayers; j < i; j++) neighbors.push(j);
      for (let j = i + 1; j <= i + s.topLayers; j++) neighbors.push(j);
      for (const j of neighbors) {
        const iv = scanIntervals(prepOutline(j, sign), ys);
        if (C === null) C = iv;
        else {
          let any = false;
          for (let k = 0; k < ys.length; k++) { C[k] = C[k].length && iv[k].length ? intersectIntervals(C[k], iv[k]) : []; if (C[k].length) any = true; }
          if (!any) break;
        }
      }
    }
    const c = Math.cos(angle), sn = Math.sin(angle);
    const segs = [];
    const push = (y, a, b, minLen, kind) => {
      if (b - a < minLen) return;
      segs.push({ x0: a * c - y * sn, y0: a * sn + y * c, x1: b * c - y * sn, y1: b * sn + y * c, kind });
    };
    for (let idx = 0; idx < ys.length; idx++) {
      const k = k0 + idx;
      const y = ys[idx];
      const Sk = S[idx];
      if (!Sk.length) continue;
      if (wholeSolid || !C || !C[idx].length) {
        for (let r = 0; r < Sk.length; r += 2) push(y, Sk[r], Sk[r + 1], lw * 0.5, 'solid');
        continue;
      }
      const solid = subtractIntervals(Sk, C[idx]);
      for (let r = 0; r < solid.length; r += 2) push(y, solid[r], solid[r + 1], lw * 0.5, 'solid');
      if (sparseEvery !== Infinity && (((k % sparseEvery) + sparseEvery) % sparseEvery) === 0) {
        const sparse = intersectIntervals(Sk, C[idx]);
        for (let r = 0; r < sparse.length; r += 2) push(y, sparse[r], sparse[r + 1], lw, 'sparse');
      }
    }
    layerInfill[i] = segs;
  }

  // ---- 6. supports --------------------------------------------------------------------------
  let supportLayers = null;
  if (s.supports) {
    const sup = computeSupports({ pos, idx: mesh.indices, outlines: layerOutlines, tops, layerHeight: lh, bbox: placed });
    supportLayers = sup.layers;
    if (!sup.columns) warnings.push('Supports were requested but no overhangs need them');
  }

  // ---- 7. G-code ----------------------------------------------------------------------------
  const filArea = Math.PI * (s.material.filamentDiameterMm / 2) ** 2;
  const g = new Emitter(s, filArea);
  const flavor = s.printer.flavor;
  const start = startGcode(s, g);
  const layerChunks = [];
  const layerTimes = [];
  for (let i = 0; i < L; i++) {
    const t0 = g.time;
    g.out = [];
    g.out.push(`;LAYER:${i}`, `;Z:${num(tops[i])}`, '__M73__');
    if (i === 1) g.out.push(`M106 S${Math.round((255 * s.material.fanPercent) / 100)}`);
    g.retract(); // retract on layer change
    g.moveZ(tops[i]);
    const h = heights[i];
    const wallF = i === 0 ? s.firstLayerSpeed : s.wallSpeed;
    const fillF = i === 0 ? s.firstLayerSpeed : s.printSpeed;

    // walls, island by island (nearest first), inner perimeters first and outer last
    const islands = orderByNearest(layerIslands[i].filter((x) => x.walls.length), (x) => [x.walls[0][0][0], x.walls[0][0][1]], g);
    for (const isl of islands) {
      g.out.push(';TYPE:WALL');
      for (let k = isl.walls.length - 1; k >= 0; k--) for (const loop of isl.walls[k]) g.loop(loop, wallF, h);
    }
    // infill
    const fill = layerInfill[i];
    if (fill.length) {
      g.out.push(';TYPE:FILL');
      for (const sg of orderSegments(fill, g)) g.segment(sg, fillF, h);
    }
    // supports
    if (supportLayers && supportLayers[i] && supportLayers[i].length) {
      g.out.push(';TYPE:SUPPORT');
      const segs = supportLayers[i].map(([x0, y0, x1, y1]) => ({ x0, y0, x1, y1 }));
      for (const sg of orderSegments(segs, g)) g.segment(sg, fillF, h);
    }
    layerTimes.push(g.time - t0 + 0.5);
    layerChunks.push(g.out);
  }

  const accel = 1.12;
  const totalTime = layerTimes.reduce((a, b) => a + b, 0) * accel + g.startTime;
  let cum = g.startTime;
  const body = [];
  for (let i = 0; i < L; i++) {
    for (const line of layerChunks[i]) {
      if (line === '__M73__') {
        if (flavor !== 'klipper') body.push(`M73 P${Math.min(99, Math.floor((100 * cum) / totalTime))} R${Math.ceil((totalTime - cum) / 60)}`);
      } else body.push(line);
    }
    cum += layerTimes[i] * accel;
  }

  g.out = [];
  endGcode(s, g, tops[L - 1]);
  const end = g.out;
  if (flavor !== 'klipper') end.push('M73 P100 R0');

  const filamentLengthMm = g.filament;
  const filamentGrams = (filamentLengthMm * filArea * s.material.densityGcm3) / 1000;
  const printTimeSec = Math.round(totalTime);
  const header = [
    '; generated by Prompt2Print built-in slicer',
    `;FLAVOR:${flavor === 'klipper' ? 'Klipper' : flavor === 'bambu' ? 'Generic (Bambu Lab)' : 'Marlin'}`,
    `;TIME:${printTimeSec}`,
    `;Filament used: ${num(filamentLengthMm / 1000, 5)}m`,
    `;Layer height: ${lh}`,
    `;LAYER_COUNT:${L}`,
    `;MINX:${num(placed.minX)}`, `;MINY:${num(placed.minY)}`, ';MINZ:0',
    `;MAXX:${num(placed.maxX)}`, `;MAXY:${num(placed.maxY)}`, `;MAXZ:${num(height)}`,
    `; job: ${s.jobName}`,
    `; printer: ${String(s.printer.name).replace(/[\r\n]+/g, ' ')} (${bed.x}x${bed.y}x${bed.z} mm)`,
    `; material: ${s.material.code} nozzle ${s.material.nozzleTemp}C bed ${s.material.bedTemp}C`,
    `; infill: ${s.infillPercent}% walls: ${s.wallLoops} top/bottom layers: ${s.topLayers}/${s.bottomLayers} supports: ${s.supports ? 'yes' : 'no'}`,
    `; estimated filament: ${num(filamentGrams, 2)} g`,
  ];
  for (const w of warnings) header.push(`; warning: ${w}`);

  const gcode = [...header, ...start, ...body, ...end, ''].join('\n');
  return {
    gcode,
    stats: {
      layers: L,
      layerHeight: lh,
      filamentLengthMm: +filamentLengthMm.toFixed(1),
      filamentGrams: +filamentGrams.toFixed(2),
      printTimeSec,
      sizeMm: size.map((v) => +v.toFixed(2)),
      warnings,
    },
  };
}

// Offset every loop of an island by d toward the material. Returns [outer, ...holes] or null
// when the island collapses or the walls would overlap (thin region).
function offsetIsland(isl, d) {
  const outer = offsetLeft(isl.outer, d);
  if (!outer) return null;
  const a = polyArea(outer);
  if (!(a > 0.02) || a >= polyArea(isl.outer)) return null;
  const res = [outer];
  for (const hole of isl.holes) {
    const h = offsetLeft(hole, d);
    if (!h) continue;
    const ha = polyArea(h);
    if (!(ha < 0) || -ha >= a) return null;
    // the grown hole must still sit inside the shrunk outer contour
    const n = h.length / 2;
    for (let s = 0; s < 4; s++) {
      const p = Math.floor((s * n) / 4);
      if (!pointInPolygon(h[p * 2], h[p * 2 + 1], outer)) return null;
    }
    res.push(h);
  }
  return res;
}

function orderByNearest(items, startOf, g) {
  const left = items.slice();
  const out = [];
  let x = g.x ?? 0, y = g.y ?? 0;
  while (left.length) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < left.length; i++) {
      const [px, py] = startOf(left[i]);
      const d = (px - x) ** 2 + (py - y) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    const it = left.splice(best, 1)[0];
    out.push(it);
    [x, y] = startOf(it);
  }
  return out;
}

// Greedy nearest-neighbour ordering; each segment may be flipped. Falls back to scan order for
// very large sets to keep slicing fast.
function orderSegments(segs, g) {
  if (segs.length > 4000) {
    return segs.map((sg, i) => (i % 2 ? { x0: sg.x1, y0: sg.y1, x1: sg.x0, y1: sg.y0 } : sg));
  }
  const n = segs.length;
  const used = new Uint8Array(n);
  const out = [];
  let x = g.x ?? 0, y = g.y ?? 0;
  for (let c = 0; c < n; c++) {
    let best = -1, bd = Infinity, flip = false;
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      const sg = segs[i];
      const d0 = (sg.x0 - x) ** 2 + (sg.y0 - y) ** 2;
      const d1 = (sg.x1 - x) ** 2 + (sg.y1 - y) ** 2;
      if (d0 < bd) { bd = d0; best = i; flip = false; }
      if (d1 < bd) { bd = d1; best = i; flip = true; }
    }
    used[best] = 1;
    const sg = segs[best];
    const o = flip ? { x0: sg.x1, y0: sg.y1, x1: sg.x0, y1: sg.y0 } : { x0: sg.x0, y0: sg.y0, x1: sg.x1, y1: sg.y1 };
    out.push(o);
    x = o.x1; y = o.y1;
  }
  return out;
}

class Emitter {
  constructor(s, filArea) {
    this.s = s;
    this.filArea = filArea;
    this.out = [];
    this.x = null; this.y = null; this.z = 0;
    this.f = null;
    this.retracted = false;
    this.time = 0;
    this.startTime = 0;
    this.filament = 0;
    this.minRetractTravel = 1.5;
  }
  feed(speed) {
    const f = Math.round(speed * 60);
    if (f === this.f) return '';
    this.f = f;
    return ` F${f}`;
  }
  retract() {
    if (this.retracted || this.s.retractMm <= 0) { this.retracted = true; return; }
    this.out.push(`G1 E-${num(this.s.retractMm, 5)}${this.feed(this.s.retractSpeed)}`);
    this.retracted = true;
    this.time += this.s.retractMm / this.s.retractSpeed;
  }
  unretract() {
    if (!this.retracted) return;
    if (this.s.retractMm > 0) {
      this.out.push(`G1 E${num(this.s.retractMm, 5)}${this.feed(this.s.retractSpeed)}`);
      this.time += this.s.retractMm / this.s.retractSpeed;
    }
    this.retracted = false;
  }
  moveZ(z) {
    const dz = Math.abs(z - this.z);
    this.out.push(`G0 Z${num(z)}${this.feed(10)}`);
    this.z = z;
    this.time += dz / 10;
  }
  travel(x, y) {
    const d = this.x === null ? Infinity : Math.hypot(x - this.x, y - this.y);
    if (d < 1e-4) return;
    if (d > this.minRetractTravel) this.retract();
    this.out.push(`G0 X${num(x)} Y${num(y)}${this.feed(this.s.travelSpeed)}`);
    if (Number.isFinite(d)) this.time += d / this.s.travelSpeed;
    this.x = x; this.y = y;
  }
  extrude(x, y, speed, h) {
    const d = Math.hypot(x - this.x, y - this.y);
    if (d < 1e-4) return;
    this.unretract();
    const e = (d * this.s.lineWidth * h) / this.filArea;
    this.out.push(`G1 X${num(x)} Y${num(y)} E${num(e, 5)}${this.feed(speed)}`);
    this.filament += e;
    this.time += d / speed;
    this.x = x; this.y = y;
  }
  loop(p, speed, h) {
    const n = p.length / 2;
    if (n < 3) return;
    // seam at the vertex nearest to the nozzle
    let best = 0, bd = Infinity;
    const cx = this.x ?? 0, cy = this.y ?? 0;
    for (let i = 0; i < n; i++) {
      const d = (p[i * 2] - cx) ** 2 + (p[i * 2 + 1] - cy) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    this.travel(p[best * 2], p[best * 2 + 1]);
    for (let k = 1; k <= n; k++) {
      const i = (best + k) % n;
      this.extrude(p[i * 2], p[i * 2 + 1], speed, h);
    }
  }
  segment(sg, speed, h) {
    this.travel(sg.x0, sg.y0);
    this.extrude(sg.x1, sg.y1, speed, h);
  }
}

function startGcode(s, g) {
  const { nozzleTemp: nt, bedTemp: bt } = s.material;
  const bed = s.printer.bed;
  const lines = [];
  if (s.printer.flavor === 'klipper') {
    lines.push(
      '; --- start (Klipper) ---',
      '; PRINT_START is expected to heat, home and purge. If your config has no PRINT_START macro,',
      `; replace the next line with: M190 S${bt} / M109 S${nt} / G28 / G92 E0`,
      `PRINT_START BED=${bt} EXTRUDER=${nt}`,
      'G90',
      'M83',
      'G92 E0',
      'M107',
    );
    g.startTime = 0;
    g.x = null; g.y = null; g.z = 0;
    return lines;
  }
  if (s.printer.flavor === 'bambu') {
    lines.push(
      '; --- start (generic, Bambu Lab) ---',
      '; NOTE: Bambu Lab printers expect jobs sliced by Bambu Studio or OrcaSlicer (.gcode.3mf).',
      '; This generic G-code is meant for testing; configure OrcaSlicer CLI for production Bambu jobs.',
    );
  } else {
    lines.push('; --- start (Marlin) ---');
  }
  lines.push(
    'M107',
    `M140 S${bt}`,
    `M104 S${nt}`,
    `M190 S${bt}`,
    `M109 S${nt}`,
    'G28 ; home all axes',
    'G90',
    'M83',
    'G92 E0',
    '; purge line',
  );
  // purge line along the left edge of the bed
  const py = Math.min(110, bed.y - 10);
  const purgeArea = 0.6 * 0.3;
  const e1 = ((py - 10) * purgeArea) / g.filArea;
  lines.push(
    'G0 Z2 F600',
    `G0 X3 Y10 F${Math.round(s.travelSpeed * 60)}`,
    'G0 Z0.3 F600',
    `G1 X3 Y${num(py)} E${num(e1, 5)} F1500`,
    `G0 X3.5 Y${num(py)}`,
    `G1 X3.5 Y10 E${num(e1, 5)} F1500`,
  );
  if (s.retractMm > 0) lines.push(`G1 E-${num(s.retractMm, 5)} F${Math.round(s.retractSpeed * 60)}`);
  lines.push('G0 Z2 F600');
  g.filament += 2 * e1;
  g.retracted = s.retractMm > 0;
  g.x = 3.5; g.y = 10; g.z = 2;
  g.f = 600;
  g.startTime = (2 * (py - 10)) / 25 + 5;
  return lines;
}

function endGcode(s, g, topZ) {
  const bed = s.printer.bed;
  g.out.push('; --- end ---');
  g.retract();
  const z = Math.min(topZ + 10, bed.z);
  g.out.push(`G0 Z${num(z)} F600`);
  g.out.push(`G0 X5 Y${num(Math.max(5, bed.y - 10))} F${Math.round(s.travelSpeed * 60)}`);
  g.out.push('M106 S0', 'M104 S0', 'M140 S0', 'M84');
  if (s.printer.flavor === 'klipper') g.out.push('; PRINT_END  (uncomment if your printer config defines PRINT_END)');
}
