// Mesh analysis: volume, surface area, watertightness and overhangs.
// The results are stored per model at scale 1 and re-used for any size the customer picks
// (volume scales with s³, areas with s², lengths with s).

import { computeBBox, signedVolume, surfaceArea, triNormalRaw } from './core.js';
import { thicknessProfile, thinShare, thicknessAt } from './thickness.js';

// Edge topology. In a watertight, consistently-oriented mesh every undirected edge is used by
// exactly two triangles, once in each direction.
export function edgeTopology(mesh) {
  const ix = mesh.indices;
  const nv = mesh.positions.length / 3;
  const undirected = new Map(); // key -> count
  const directed = new Map();   // key -> count
  const key = (a, b) => a * nv + b; // safe for meshes below ~94M vertices
  for (let t = 0; t < ix.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = ix[t + e], b = ix[t + ((e + 1) % 3)];
      const dk = key(a, b);
      directed.set(dk, (directed.get(dk) || 0) + 1);
      const uk = a < b ? key(a, b) : key(b, a);
      undirected.set(uk, (undirected.get(uk) || 0) + 1);
    }
  }
  let boundaryEdges = 0, nonManifoldEdges = 0, flippedEdges = 0;
  for (const c of undirected.values()) {
    if (c === 1) boundaryEdges++;
    else if (c > 2) nonManifoldEdges++;
  }
  for (const c of directed.values()) if (c > 1) flippedEdges += c - 1;
  return { edges: undirected.size, boundaryEdges, nonManifoldEdges, flippedEdges };
}

export function countDegenerate(mesh, minArea = 1e-10) {
  const p = mesh.positions, ix = mesh.indices;
  let n = 0;
  for (let t = 0; t < ix.length; t += 3) {
    const nr = triNormalRaw(p, ix[t], ix[t + 1], ix[t + 2]);
    if (Math.hypot(nr[0], nr[1], nr[2]) / 2 < minArea) n++;
  }
  return n;
}

// Area of downward-facing surfaces steeper than `maxOverhangDeg` from vertical,
// ignoring faces that rest on the bed.
export function overhangArea(mesh, maxOverhangDeg = 45, bedTolerance = 0.3) {
  const p = mesh.positions, ix = mesh.indices;
  const bb = computeBBox(mesh);
  const limit = Math.cos((maxOverhangDeg * Math.PI) / 180); // -nz above this needs support
  let area = 0;
  for (let t = 0; t < ix.length; t += 3) {
    const nr = triNormalRaw(p, ix[t], ix[t + 1], ix[t + 2]);
    const len = Math.hypot(nr[0], nr[1], nr[2]);
    if (len === 0) continue;
    const nz = nr[2] / len;
    if (-nz <= limit) continue;
    const zMax = Math.max(p[ix[t] * 3 + 2], p[ix[t + 1] * 3 + 2], p[ix[t + 2] * 3 + 2]);
    if (zMax - bb.min[2] <= bedTolerance) continue; // sits on the bed
    area += len / 2;
  }
  return area;
}

// Full analysis at scale 1. Stored with the model.
export function analyzeMesh(mesh) {
  const bbox = computeBBox(mesh);
  const topo = edgeTopology(mesh);
  const vol = signedVolume(mesh);
  const degenerate = countDegenerate(mesh);
  return {
    triangles: mesh.indices.length / 3,
    vertices: mesh.positions.length / 3,
    volumeMm3: Math.abs(vol),
    inverted: vol < 0,
    areaMm2: surfaceArea(mesh),
    bbox: { min: bbox.min, max: bbox.max, size: bbox.size },
    watertight: topo.boundaryEdges === 0 && topo.nonManifoldEdges === 0 && topo.flippedEdges === 0,
    boundaryEdges: topo.boundaryEdges,
    nonManifoldEdges: topo.nonManifoldEdges,
    flippedEdges: topo.flippedEdges,
    degenerateTriangles: degenerate,
    overhangAreaMm2: overhangArea(mesh),
    thickness: thicknessProfile(mesh),
  };
}

// Does a box of size [x, y, z] fit a printer's build volume? Allows a 90° turn on the bed.
export function fitsBuildVolume(size, bed, marginMm = 4) {
  const bx = bed.x - marginMm, by = bed.y - marginMm, bz = bed.z - marginMm;
  const [x, y, z] = size;
  if (z > bz) return false;
  return (x <= bx && y <= by) || (x <= by && y <= bx);
}

export function maxScaleForBed(size, bed, marginMm = 4) {
  const bx = bed.x - marginMm, by = bed.y - marginMm, bz = bed.z - marginMm;
  const [x, y, z] = size.map((v) => Math.max(v, 1e-6));
  const straight = Math.min(bx / x, by / y);
  const turned = Math.min(by / x, bx / y);
  return Math.min(Math.max(straight, turned), bz / z);
}

/**
 * Printability report for a model at a given uniform scale.
 * @param analysis result of analyzeMesh (scale 1)
 * @param scale uniform scale factor chosen by the customer
 * @param printers [{ name, bed: {x,y,z}, materials: ['PLA', ...], active }]
 * @param material material code, e.g. 'PLA'
 */
// Smallest scale at which at most `share` of the surface is thinner than `minWallMm`.
export function minScaleForWalls(analysis, minWallMm = 2, share = 0.03) {
  if (!analysis.thickness) return 0;
  const t = thicknessAt(analysis.thickness, share);
  return t > 0 && Number.isFinite(t) ? (minWallMm * 0.95) / t : 0;
}

export function checkPrintability(analysis, scale, printers, material, opts = {}) {
  const minFeatureMm = opts.minSizeMm ?? 10;
  const supportAreaLimit = opts.supportAreaLimitMm2 ?? 25;
  const maxModelMm = opts.maxModelMm ?? 250;      // the largest model we print, on any axis
  const minWallMm = opts.minWallMm ?? 2;          // minimum wall thickness for durability
  const size = analysis.bbox.size.map((v) => v * scale);
  const capable = printers.filter((p) => p.active !== false && (!material || p.materials.includes(material)));
  const withinLimit = Math.max(...size) <= maxModelMm + 1e-6;
  const fitting = withinLimit ? capable.filter((p) => fitsBuildVolume(size, p.bed)) : [];
  const limitScale = maxModelMm / Math.max(...analysis.bbox.size, 1e-6);
  const maxScale = Math.min(limitScale, capable.reduce((m, p) => Math.max(m, maxScaleForBed(analysis.bbox.size, p.bed)), 0));
  const overhang = analysis.overhangAreaMm2 * scale * scale;
  const checks = [];

  checks.push({
    id: 'watertight',
    status: analysis.watertight ? 'pass' : 'fail',
    detail: analysis.watertight
      ? 'Closed, watertight mesh'
      : `Mesh has ${analysis.boundaryEdges} open edges, ${analysis.nonManifoldEdges} non-manifold edges and ${analysis.flippedEdges} flipped edges`,
  });

  if (capable.length === 0) {
    checks.push({ id: 'bed', status: 'fail', detail: `No active printer can print ${material}` });
  } else {
    checks.push({
      id: 'bed',
      status: fitting.length ? 'pass' : 'fail',
      detail: fitting.length
        ? `Fits ${fitting.length} printer(s), e.g. ${fitting[0].name}`
        : `Too large: the largest side can be at most ${maxModelMm} mm (${Math.round(maxScale * 100)}% of this design).`,
      maxScale,
      maxModelMm,
    });
  }

  // Wall thickness: at least `minWallMm` so items survive knocks and drops.
  if (analysis.thickness) {
    const thin = thinShare(analysis.thickness, scale, minWallMm * 0.95);
    const minScale = minScaleForWalls(analysis, minWallMm);
    const status = thin > 0.15 ? 'fail' : thin > 0.03 ? 'warn' : 'pass';
    checks.push({
      id: 'walls',
      status,
      thinPercent: Math.round(thin * 1000) / 10,
      minScale,
      minLargestMm: Math.ceil(minScale * Math.max(...analysis.bbox.size)),
      detail: status === 'pass'
        ? `Walls are at least ${minWallMm} mm`
        : `${Math.round(thin * 100)}% of the surface is thinner than ${minWallMm} mm${status === 'fail' ? ` — make it at least ${Math.ceil(minScale * Math.max(...analysis.bbox.size))} mm` : ' and may break if dropped'}`,
    });
  }

  // Long, thin shapes break more easily.
  const sorted = [...size].sort((a, b) => a - b);
  const slender = sorted[0] > 0 && sorted[2] / sorted[0] > 8;
  checks.push({
    id: 'shape',
    status: slender ? 'warn' : 'pass',
    detail: slender ? 'Long, thin shape: it may snap if dropped' : 'Compact, sturdy shape',
  });

  checks.push({
    id: 'min_size',
    status: Math.max(...size) >= minFeatureMm ? 'pass' : 'fail',
    detail: Math.max(...size) >= minFeatureMm ? 'Large enough to print' : `Smaller than ${minFeatureMm} mm`,
  });

  const needsSupports = overhang > supportAreaLimit;
  checks.push({
    id: 'supports',
    status: needsSupports ? 'warn' : 'pass',
    detail: needsSupports
      ? `About ${Math.round(overhang)} mm² of overhangs: printed with supports`
      : 'No supports needed',
    needsSupports,
  });

  const ok = checks.every((c) => c.status !== 'fail');
  const fragile = checks.some((c) => (c.id === 'walls' || c.id === 'shape') && c.status === 'warn');
  return {
    ok, needsSupports, fragile, sizeMm: size, checks, maxScale,
    minScale: analysis.thickness ? minScaleForWalls(analysis, minWallMm) : 0,
    printerIds: fitting.map((p) => p.id),
  };
}
