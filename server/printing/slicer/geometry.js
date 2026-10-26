// 2D polygon helpers for the built-in slicer.
// A polygon/loop is a flat array [x0, y0, x1, y1, ...] (Float64Array or Array), implicitly closed.

export function polyArea(p) {
  const n = p.length / 2;
  let a = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) a += p[j * 2] * p[i * 2 + 1] - p[i * 2] * p[j * 2 + 1];
  return a / 2;
}

export function reversePoly(p) {
  const n = p.length / 2;
  const out = new Float64Array(p.length);
  for (let i = 0; i < n; i++) {
    out[i * 2] = p[(n - 1 - i) * 2];
    out[i * 2 + 1] = p[(n - 1 - i) * 2 + 1];
  }
  return out;
}

export function polyBBox(p) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < p.length; i += 2) {
    const x = p[i], y = p[i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

// Even-odd point in polygon.
export function pointInPolygon(x, y, p) {
  const n = p.length / 2;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = p[i * 2], yi = p[i * 2 + 1], xj = p[j * 2], yj = p[j * 2 + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Remove consecutive duplicates (closer than eps), including the wrap-around.
export function dedupePoints(p, eps = 1e-4) {
  const out = [];
  const n = p.length / 2;
  for (let i = 0; i < n; i++) {
    const x = p[i * 2], y = p[i * 2 + 1];
    const m = out.length;
    if (m >= 2 && Math.abs(out[m - 2] - x) < eps && Math.abs(out[m - 1] - y) < eps) continue;
    out.push(x, y);
  }
  while (out.length >= 4) {
    const m = out.length;
    if (Math.abs(out[m - 2] - out[0]) < eps && Math.abs(out[m - 1] - out[1]) < eps) out.length = m - 2;
    else break;
  }
  return out;
}

// Ramer–Douglas–Peucker for a closed loop.
export function simplifyClosed(p, tol = 0.01) {
  const n = p.length / 2;
  if (n <= 8) return p;
  // Split at point 0 and the point farthest from it.
  let far = 0, farD = -1;
  for (let i = 1; i < n; i++) {
    const d = (p[i * 2] - p[0]) ** 2 + (p[i * 2 + 1] - p[1]) ** 2;
    if (d > farD) { farD = d; far = i; }
  }
  const keep = new Uint8Array(n);
  keep[0] = 1; keep[far] = 1;
  const tol2 = tol * tol;
  const stack = [[0, far], [far, n]]; // segment [a, b] with b possibly n (= index 0)
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const ax = p[a * 2], ay = p[a * 2 + 1];
    const bi = b % n;
    const bx = p[bi * 2], by = p[bi * 2 + 1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const px = p[i * 2] - ax, py = p[i * 2 + 1] - ay;
      let d2;
      if (len2 < 1e-12) d2 = px * px + py * py;
      else {
        const cross = px * dy - py * dx;
        d2 = (cross * cross) / len2;
      }
      if (d2 > maxD) { maxD = d2; idx = i; }
    }
    if (maxD > tol2) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(p[i * 2], p[i * 2 + 1]);
  return out;
}

/**
 * Offset a closed polygon by distance d to the LEFT of the direction of travel.
 * For a CCW outer contour that is inward; for a CW hole it is outward (into material).
 * Miter joins with a clamped miter length. Edges that flip direction (collapsed features)
 * are removed iteratively. Returns null when the loop collapses.
 */
export function offsetLeft(p, d, miterLimit = 2.5) {
  const n = p.length / 2;
  if (n < 3) return null;
  // Each source edge k (p_k → p_k+1) becomes an offset line: point o_k, direction u_k.
  let edges = [];
  for (let k = 0; k < n; k++) {
    const k2 = (k + 1) % n;
    const ax = p[k * 2], ay = p[k * 2 + 1];
    let ux = p[k2 * 2] - ax, uy = p[k2 * 2 + 1] - ay;
    const len = Math.hypot(ux, uy);
    if (len < 1e-9) continue;
    ux /= len; uy /= len;
    edges.push({ ax, ay, ux, uy, ox: ax - uy * d, oy: ay + ux * d });
  }
  const maxMiter = miterLimit * Math.abs(d);
  // Vertex joining edge a (incoming) and edge b (outgoing).
  const join = (a, b) => {
    const cross = a.ux * b.uy - a.uy * b.ux;
    // source corner (intersection of the source lines; falls back to b's start point)
    let cx = b.ax, cy = b.ay;
    if (Math.abs(cross) > 1e-9) {
      const t = ((b.ax - a.ax) * b.uy - (b.ay - a.ay) * b.ux) / cross;
      cx = a.ax + a.ux * t; cy = a.ay + a.uy * t;
    }
    let vx, vy;
    if (Math.abs(cross) < 1e-9) { vx = b.ox; vy = b.oy; }
    else {
      const t = ((b.ox - a.ox) * b.uy - (b.oy - a.oy) * b.ux) / cross;
      vx = a.ox + a.ux * t; vy = a.oy + a.uy * t;
    }
    const mx = vx - cx, my = vy - cy;
    const ml = Math.hypot(mx, my);
    if (ml > maxMiter) { vx = cx + (mx * maxMiter) / ml; vy = cy + (my * maxMiter) / ml; }
    return [vx, vy];
  };
  // Iteratively drop edges whose offset segment reversed direction (collapsed features),
  // re-joining their neighbours by intersecting the neighbours' offset lines.
  let verts = null;
  for (let iter = 0; iter < n + 5; iter++) {
    const m = edges.length;
    if (m < 3) return null;
    verts = new Array(m);
    for (let k = 0; k < m; k++) verts[k] = join(edges[(k - 1 + m) % m], edges[k]); // start vertex of edge k
    const keep = [];
    for (let k = 0; k < m; k++) {
      const s = verts[k], e = verts[(k + 1) % m];
      const dot = (e[0] - s[0]) * edges[k].ux + (e[1] - s[1]) * edges[k].uy;
      if (dot >= 0) keep.push(edges[k]);
    }
    if (keep.length === m) break;
    edges = keep;
    verts = null;
  }
  if (!verts || verts.length < 3) return null;
  const out = new Float64Array(verts.length * 2);
  for (let i = 0; i < verts.length; i++) { out[i * 2] = verts[i][0]; out[i * 2 + 1] = verts[i][1]; }
  return out;
}

// ---- Scanline machinery -------------------------------------------------------------------

/**
 * Prepare the edges of a set of loops for horizontal scanlines in a frame rotated by -angle
 * (x' = x cos a + y sin a, y' = -x sin a + y cos a). Edges are sorted by their lower y'.
 */
export function prepareEdges(loops, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const list = [];
  let ymin = Infinity, ymax = -Infinity;
  for (const p of loops) {
    const n = p.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xa = p[j * 2] * c + p[j * 2 + 1] * s, ya = -p[j * 2] * s + p[j * 2 + 1] * c;
      const xb = p[i * 2] * c + p[i * 2 + 1] * s, yb = -p[i * 2] * s + p[i * 2 + 1] * c;
      if (ya === yb) continue;
      const lo = ya < yb;
      const y0 = lo ? ya : yb, y1 = lo ? yb : ya, x0 = lo ? xa : xb, x1 = lo ? xb : xa;
      list.push({ y0, y1, x0, k: (x1 - x0) / (y1 - y0) });
      if (y0 < ymin) ymin = y0;
      if (y1 > ymax) ymax = y1;
    }
  }
  list.sort((a, b) => a.y0 - b.y0);
  const m = list.length;
  const Y0 = new Float64Array(m), Y1 = new Float64Array(m), X0 = new Float64Array(m), K = new Float64Array(m);
  for (let i = 0; i < m; i++) { Y0[i] = list[i].y0; Y1[i] = list[i].y1; X0[i] = list[i].x0; K[i] = list[i].k; }
  return { Y0, Y1, X0, K, count: m, ymin, ymax };
}

/**
 * Even-odd interior intervals along each scanline y' in `ys` (must be ascending).
 * Returns an array (one per y) of flat interval arrays [a0, b0, a1, b1, ...] sorted by x'.
 */
export function scanIntervals(prep, ys) {
  const out = new Array(ys.length);
  const { Y0, Y1, X0, K, count } = prep;
  let ptr = 0;
  let active = [];
  const xs = [];
  for (let li = 0; li < ys.length; li++) {
    const y = ys[li];
    while (ptr < count && Y0[ptr] <= y) active.push(ptr++);
    if (active.length) {
      // drop finished edges (half-open [y0, y1))
      let w = 0;
      for (let r = 0; r < active.length; r++) { const e = active[r]; if (Y1[e] > y) active[w++] = e; }
      active.length = w;
    }
    if (active.length < 2) { out[li] = EMPTY; continue; }
    xs.length = 0;
    for (let r = 0; r < active.length; r++) { const e = active[r]; xs.push(X0[e] + (y - Y0[e]) * K[e]); }
    xs.sort((a, b) => a - b);
    const iv = [];
    for (let r = 0; r + 1 < xs.length; r += 2) if (xs[r + 1] > xs[r]) iv.push(xs[r], xs[r + 1]);
    out[li] = iv;
  }
  return out;
}

const EMPTY = Object.freeze([]);

export function intersectIntervals(a, b) {
  const out = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i], b[j]), hi = Math.min(a[i + 1], b[j + 1]);
    if (hi > lo) out.push(lo, hi);
    if (a[i + 1] < b[j + 1]) i += 2; else j += 2;
  }
  return out;
}

export function subtractIntervals(a, b) {
  const out = [];
  let j = 0;
  for (let i = 0; i < a.length; i += 2) {
    let lo = a[i];
    const hi = a[i + 1];
    while (j < b.length && b[j + 1] <= lo) j += 2;
    let k = j;
    while (k < b.length && b[k] < hi) {
      if (b[k] > lo) out.push(lo, b[k]);
      lo = Math.max(lo, b[k + 1]);
      k += 2;
    }
    if (hi > lo) out.push(lo, hi);
  }
  return out;
}

// Is x inside any interval of the sorted flat interval array? Returns the distance to the
// nearest interval edge as well (negative = outside).
export function intervalLookup(iv, x) {
  let lo = 0, hi = iv.length / 2 - 1;
  let nearest = Infinity;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const a = iv[mid * 2], b = iv[mid * 2 + 1];
    if (x < a) { nearest = Math.min(nearest, a - x); hi = mid - 1; }
    else if (x > b) { nearest = Math.min(nearest, x - b); lo = mid + 1; }
    else return { inside: true, dist: Math.min(x - a, b - x) };
  }
  return { inside: false, dist: nearest };
}
