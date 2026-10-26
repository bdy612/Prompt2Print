// Offline "prompt → 3D model" generator.
//
// A stand-in for a real text-to-3D service so the shop works without an API key. It reads the prompt
// (English or Arabic), picks an object type and style modifiers, and builds a closed, printable mesh
// from parametric parts. The same (prompt, seed) always gives the same model; another seed gives a
// visibly different variation.
//
// Shop rules built into every model:
//  • nothing for food or drink (no mugs, cups, bowls, plates);
//  • walls at least 2 mm thick (vessels 2.8–3 mm), rounded rims and edges, no thin spikes;
//  • compact shapes that print without supports where the object allows it;
//  • largest dimension at most 245 mm.

import {
  Builder, TAU, lathe, loft, box, sweepRings, circleSection, washer, icosphere, prism,
  sections, ringRadiusAt, pchip, bezier2D, segmentsFor, xf, vadd, vsub, vscale, vnorm, vcross, vdot,
  roundCorners, extrudeChamfer, ellipsoid, tube, stud, blob,
} from './procedural/geometry.js';
import { parsePrompt, composeTitle, featureList, joinList, NOUNS } from './procedural/text.js';
import { placeOnBed, computeBBox, scaleMesh } from '../mesh/core.js';

export const DEMO_CATEGORIES = [
  { id: 'vase', nameEn: 'Vases', nameAr: 'مزهريات', group: 'decor' },
  { id: 'planter', nameEn: 'Planters', nameAr: 'أصص زرع', group: 'decor' },
  { id: 'lamp', nameEn: 'Lamp shades', nameAr: 'أغطية مصابيح', group: 'decor' },
  { id: 'ornament', nameEn: 'Ornaments', nameAr: 'زينة معلقة', group: 'decor' },
  { id: 'sculpture', nameEn: 'Sculptures & figurines', nameAr: 'منحوتات ومجسمات', group: 'decor' },
  { id: 'bookend', nameEn: 'Bookends', nameAr: 'مساند كتب', group: 'decor' },
  { id: 'chess', nameEn: 'Chess pieces', nameAr: 'قطع شطرنج', group: 'games' },
  { id: 'dice', nameEn: 'Dice', nameAr: 'نرد', group: 'games' },
  { id: 'castle', nameEn: 'Castles & towers', nameAr: 'قلاع وأبراج', group: 'toys' },
  { id: 'rocket', nameEn: 'Rockets', nameAr: 'صواريخ', group: 'toys' },
  { id: 'trophy', nameEn: 'Trophies', nameAr: 'كؤوس وجوائز', group: 'gifts' },
  { id: 'pen_holder', nameEn: 'Pen holders', nameAr: 'حوامل أقلام', group: 'office' },
  { id: 'organizer', nameEn: 'Organizers & boxes', nameAr: 'منظمات وعلب', group: 'office' },
  { id: 'cable', nameEn: 'Cable organizers', nameAr: 'منظمات كابلات', group: 'office' },
  { id: 'phone_stand', nameEn: 'Phone stands', nameAr: 'حوامل جوال', group: 'office' },
  { id: 'headphone_stand', nameEn: 'Headphone stands', nameAr: 'حوامل سماعات', group: 'office' },
  { id: 'hook', nameEn: 'Wall hooks & key holders', nameAr: 'علاقات جدارية', group: 'home' },
  { id: 'keychain', nameEn: 'Keychains', nameAr: 'ميداليات مفاتيح', group: 'accessories' },
];

// ---------------------------------------------------------------------------------------------
// Randomness

function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (const ch of s) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (lo, hi) => lo + (hi - lo) * next(),
    int: (lo, hi) => lo + Math.floor((hi - lo + 1) * next()),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
    sign: () => (next() < 0.5 ? -1 : 1),
  };
}

const smoothstep = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Battlements with rounded corners: `m` merlons of height h around the circle.
const merlonLift = (m, h, fill = 0.5, soft = 0.16) => (th) => {
  const q = th / (TAU / m);
  const f = q - Math.floor(q + 1e-7);
  return h * smoothstep(0, soft, f) * (1 - smoothstep(fill - soft, fill, f));
};
// Crown with rounded points.
const crownLift = (m, h) => (th) => {
  const q = th / (TAU / m);
  const f = q - Math.floor(q);
  return h * smoothstep(0, 1, 1 - Math.abs(2 * f - 1));
};

// A quarter-circle "fillet" from a flat top edge of radius R: rings that move inward and up.
function filletRings(Rfn, zTop, rho, n = 6, extra = {}) {
  const out = [];
  for (let k = 1; k <= n; k++) {
    const a = (Math.PI / 2) * (k / n);
    out.push({ r: Rfn, inset: rho * (1 - Math.cos(a)), z: zTop - rho + rho * Math.sin(a), ...extra });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Style → lathe options

function bodyStyle(styles, rnd, H, { baseSegments = 128, castleLift = null } = {}) {
  const has = (s) => styles.includes(s);
  let section = sections.round;
  const mult = [];
  let target = baseSegments;
  let samples = 40;
  let lowPoly = false;
  if (has('star')) { const n = rnd.int(5, 8); section = sections.star(n, rnd.range(0.11, 0.15)); mult.push(n * 2); target = Math.max(target, n * 24); }
  else if (has('flower')) { const n = rnd.int(5, 8); section = sections.flower(n, rnd.range(0.1, 0.16)); target = Math.max(target, 144); }
  else if (has('gear')) { const n = rnd.int(12, 18); section = sections.gear(n, rnd.range(0.04, 0.06)); target = Math.max(target, n * 12); }
  else if (has('wavy')) { const n = rnd.int(8, 16); section = sections.wavy(n, rnd.range(0.035, 0.055)); target = Math.max(target, n * 12); }
  else if (has('hexagon')) { section = sections.roundedPolygon(6, 14); mult.push(6); target = Math.max(target, 144); }
  else if (has('faceted')) { const n = rnd.int(6, 10); lowPoly = true; section = sections.roundedPolygon(n, 9); mult.push(n); target = Math.max(target, n * 20); samples = rnd.int(5, 9); }
  else if (has('castle') || has('tower')) { const n = rnd.int(8, 12); section = sections.roundedPolygon(n, 12); mult.push(n); target = Math.max(target, n * 16); }
  if (castleLift) mult.push(castleLift.m * 2);
  let twistTotal = 0;
  if (has('spiral')) twistTotal = rnd.range(1.4, 2.4) * rnd.sign();
  else if (has('twisted')) twistTotal = rnd.range(0.5, 1.0) * rnd.sign();
  // A twist is invisible on a round body, so give it soft ribs to follow.
  if (twistTotal && section === sections.round) {
    const n = rnd.int(8, 14);
    section = sections.wavy(n, rnd.range(0.035, 0.05));
    target = Math.max(target, n * 12);
  }
  const segments = segmentsFor(target, ...mult);
  return {
    opts: {
      segments,
      section,
      twist: twistTotal ? (z) => (twistTotal * z) / H : () => 0,
      lift: castleLift ? merlonLift(castleLift.m, castleLift.h) : () => 0,
    },
    samples,
    lowPoly,
  };
}

// ---------------------------------------------------------------------------------------------
// Hollow vessel profile (vases, planters, pen holders, boxes…). Walls are measured along the
// surface normal (lathe handles ribs, facets and twists), the rim is a rounded lip.

function vesselProfile(c) {
  const { H, R, wall, floor } = c;
  const bevel = c.bevel ?? 1.0;
  const n = c.samples ?? 40;
  const Rsmooth = (z) => R(clamp(z / H, 0, 1));
  const zTop = H - wall / 2;
  // The outer wall is a polyline through these samples; the inner wall is offset from that same
  // polyline (not from the smooth curve), so facets on low-poly bodies keep a full wall.
  const zs = [0], rs = [Rsmooth(0)];
  for (let i = 0; i <= n; i++) { const z = bevel + (zTop - bevel) * (i / n); zs.push(z); rs.push(Rsmooth(z)); }
  const Rz = (z) => {
    if (z <= zs[0]) return rs[0];
    for (let i = 1; i < zs.length; i++) if (z <= zs[i]) { const t = (z - zs[i - 1]) / (zs[i] - zs[i - 1] || 1e-9); return rs[i - 1] + (rs[i] - rs[i - 1]) * t; }
    return rs[rs.length - 1];
  };
  const inner = c.innerSection ? { section: c.innerSection } : {};
  const P = [];
  if (c.drainHole) P.push({ r: c.drainHole, z: 0, section: sections.round });
  else P.push({ r: 0, z: 0 });
  // Bottom chamfer steeper than 45°, so it never needs support.
  P.push({ r: Rz(0), inset: Math.max(0, 0.7 * bevel - (Rz(bevel) - Rz(0))), z: 0 });
  for (let i = 0; i <= n; i++) { const z = bevel + (zTop - bevel) * (i / n); P.push({ r: Rz(z), z }); }
  // Rounded rim: a half circle of diameter `wall` from the outer to the inner surface.
  for (let k = 1; k < 8; k++) {
    const a = (Math.PI * k) / 8;
    P.push({ r: Rz(zTop), wall: (wall * (1 - Math.cos(a))) / 2, z: zTop + (wall / 2) * Math.sin(a), lift: !!c.liftRim, ...(k >= 4 ? inner : {}) });
  }
  const zIn0 = floor + 1.5;
  for (let i = n; i >= 0; i--) { const z = zIn0 + (zTop - zIn0) * (i / n); P.push({ r: Rz(z), wall, z, ...inner }); }
  P.push({ r: Rz(floor), wall, inset: 1.5, z: floor, ...inner });
  if (c.drainHole) P.push({ r: c.drainHole, z: floor, section: sections.round });
  else P.push({ r: 0, z: floor });
  return { profile: P, Rz, wall, zTop, floor };
}

function latheVessel(b, v, opts) {
  lathe(b, v.profile, { ...opts, outerR: v.Rz });
}

// Radius of the outer surface (with section/facets) at height z and world angle theta.
function outerAt(v, latheOpts, z, theta) {
  return ringRadiusAt({ r: v.Rz(z), z }, theta, latheOpts);
}

// Make sure a radius curve never flares or narrows faster than ~42° (no overhangs inside or out).
function limitSlope(H, R, maxSlope = 0.9) {
  let worst = 0;
  for (let i = 0; i < 200; i++) {
    const t0 = i / 200, t1 = (i + 1) / 200;
    worst = Math.max(worst, Math.abs(R(t1) - R(t0)) / (H / 200));
  }
  return worst > maxSlope ? H * (worst / maxSlope) : H;
}

// A solid "spine" on the outside of a vessel wall where a handle attaches: the outer section bulges
// out by up to `amp` mm around `angle` between zLo and zHi (ramped at ≥ 50°), the inner wall does not.
function spineSection(base, Rz, { angle, amp, halfWidth = 0.38, zLo, zHi, ramp = 8 }) {
  return (th, z) => {
    let d = th - angle;
    while (d > Math.PI) d -= TAU;
    while (d < -Math.PI) d += TAU;
    const g = Math.abs(d) < halfWidth ? Math.cos((Math.PI * d) / (2 * halfWidth)) ** 2 : 0;
    const w = smoothstep(zLo, zLo + ramp, z) * (1 - smoothstep(zHi - ramp, zHi, z));
    return base(th, z) + (amp * g * w) / Math.max(1, Rz(z));
  };
}

// ---------------------------------------------------------------------------------------------
// Handles: a thick tube with a steep keel underneath (prints without supports); dragon style adds
// rounded scales along the back and two blunt horns.

function addHandle(b, rnd, { xTop, zTop, xBot, zBot, depth, radius, style, angle = 0, dragon = false, sf = 1 }) {
  const h = zTop - zBot;
  let pts;
  if (style === 'loop') pts = bezier2D([xTop, zTop], [xTop + depth * 1.45, zTop + h * 0.3], [xBot + depth * 1.45, zBot - h * 0.25], [xBot, zBot], 40);
  else if (style === 'angular') pts = bezier2D([xTop, zTop], [xTop + depth * 1.25, zTop - h * 0.02], [xBot + depth * 1.3, zBot + h * 0.08], [xBot, zBot], 40);
  else pts = bezier2D([xTop, zTop], [xTop + depth * 1.35, zTop + h * 0.12], [xBot + depth * 1.35, zBot - h * 0.08], [xBot, zBot], 40);
  const rot = xf.rotZ(angle);
  const path = pts.map(([x, z]) => rot(x, 0, z));
  let bump = null;
  if (dragon) {
    // Low rounded scales along the back of the handle, part of the same solid.
    const count = rnd.int(7, 10);
    const out = rot(1, 0, 0), side = rot(0, 1, 0);
    const centres = [];
    for (let k = 0; k < count; k++) {
      const t = 0.14 + 0.72 * (k / (count - 1));
      const lat = (k % 2 ? 1 : -1) * 0.22;
      centres.push({ t, dir: vnorm(vadd(vadd(vscale(out, 0.55), [0, 0, 0.8]), vscale(side, lat))) });
    }
    // Eyes: two bumps on the head, looking forward and out.
    const eyes = [-1, 1].map((sgn) => ({ t: 0.085, dir: vnorm(vadd(vadd(vscale(out, 0.45), [0, 0, 0.45]), vscale(side, sgn * 0.75))), amp: 1.3 / radius, st: 0.03, sa: 0.42 }));
    const amp = 2.0 / radius, st = 0.042, sa = 0.6;
    bump = (t, i, d) => {
      let v = 0;
      for (const c of centres) {
        const dt = (t - c.t) / st;
        if (Math.abs(dt) > 2.5) continue;
        const ang = Math.acos(Math.max(-1, Math.min(1, vdot(d, c.dir))));
        v = Math.max(v, amp * Math.exp(-dt * dt - (ang / sa) ** 2));
      }
      for (const e of eyes) {
        const dt = (t - e.t) / e.st;
        if (Math.abs(dt) > 2.5) continue;
        const ang = Math.acos(Math.max(-1, Math.min(1, vdot(d, e.dir))));
        v = Math.max(v, e.amp * Math.exp(-dt * dt - (ang / e.sa) ** 2));
      }
      return v;
    };
  }
  // Dragon handles swell into a head where they meet the body.
  const radiusAt = dragon ? (t) => radius * (1 + 0.42 * Math.exp(-((t / 0.13) ** 2))) : radius;
  tube(b, path, radiusAt, { keel: true, seg: dragon ? 28 : 22, bump });
  if (!dragon) return;
  // Two blunt horns on top of the head, leaning back and out.
  const n = path.length;
  const i = Math.round(0.07 * (n - 1));
  const P = path[i];
  const side = rot(0, 1, 0);
  for (const s of [-1, 1]) {
    const c = vadd(vadd(P, vscale(side, s * radius * 0.5)), [0, 0, radius * 0.9]);
    const tilt = xf.compose(xf.rotX(s * 0.4), xf.rotZ(angle));
    blob(b, c, 2.6, 2.6, 7.5 * sf, (x, y, z) => tilt(x, y, z), 2);
  }
}

// Handle that attaches to a lathe vessel at world angle `angle`. The vessel must carry a spine
// (spineSection) at that angle so the tube's end sits in solid material 4 mm deep.
function vesselHandle(b, rnd, v, latheOpts, { H, zTopF, zBotF, depth, radius, style, dragon, sf, angle = 0 }) {
  const zTop = H * zTopF, zBot = H * zBotF;
  const sample = (z) => outerAt(v, latheOpts, z, angle) - 4;
  addHandle(b, rnd, { xTop: sample(zTop), zTop, xBot: sample(zBot), zBot, depth, radius, style, angle, dragon, sf });
}

// ---------------------------------------------------------------------------------------------
// Object builders. Each returns { features: [[en, ar]...], extra } for the description.

const VASE_FAMILIES = {
  amphora: [[0, 0.55], [0.2, 0.95], [0.45, 1.0], [0.7, 0.62], [0.86, 0.5], [1, 0.62]],
  bottle: [[0, 0.85], [0.25, 1.0], [0.55, 1.0], [0.75, 0.72], [0.88, 0.4], [1, 0.44]],
  column: [[0, 0.9], [0.3, 0.95], [0.6, 1.0], [0.85, 0.98], [1, 1.04]],
  bulb: [[0, 0.6], [0.22, 1.0], [0.45, 0.94], [0.68, 0.6], [0.86, 0.46], [1, 0.56]],
  trumpet: [[0, 0.62], [0.3, 0.66], [0.6, 0.78], [0.85, 0.94], [1, 1.08]],
  ovoid: [[0, 0.62], [0.35, 1.0], [0.7, 0.88], [0.9, 0.6], [1, 0.58]],
};

function buildVase(b, rnd, ctx) {
  const { sf, hf, wf, styles } = ctx;
  const family = rnd.pick(Object.keys(VASE_FAMILIES));
  const ctl = VASE_FAMILIES[family].map(([t, r], i, arr) => [t, r * (i === 0 || i === arr.length - 1 ? 1 : rnd.range(0.95, 1.05))]);
  const Rmax = rnd.range(44, 56) * sf * wf;
  const f = pchip(ctl.map((c) => c[0]), ctl.map((c) => c[1] * Rmax));
  const H = Math.min(235, limitSlope(rnd.range(160, 205) * sf * hf, f));
  const castle = styles.includes('castle');
  const castleLift = castle ? { m: rnd.int(6, 10), h: rnd.range(6, 9) * sf } : null;
  const st = bodyStyle(styles, rnd, H, { castleLift, baseSegments: 144 });
  const v = vesselProfile({ H, R: f, wall: 2.8, floor: 4, samples: Math.max(st.samples, st.lowPoly ? 0 : 56), liftRim: !!castleLift });
  latheVessel(b, v, st.opts);
  return { family };
}

function buildPlanter(b, rnd, ctx) {
  const { sf, hf, wf, styles } = ctx;
  const Rt = rnd.range(50, 58) * sf * wf;
  const Rb = Rt * rnd.range(0.76, 0.86);
  const lip = rnd.range(1.8, 2.6);
  const R = (t) => Rb + (Rt - Rb) * t + lip * smoothstep(0.86, 0.92, t);
  const H = limitSlope(rnd.range(100, 118) * sf * hf, R);
  const castle = styles.includes('castle');
  const castleLift = castle ? { m: rnd.int(7, 11), h: rnd.range(6, 8) * sf } : null;
  const st = bodyStyle(styles, rnd, H, { castleLift, baseSegments: 160 });
  const v = vesselProfile({ H, R, wall: 3, floor: 4, samples: st.samples, drainHole: 6 * Math.min(1, sf + 0.2), liftRim: !!castleLift });
  latheVessel(b, v, st.opts);
  return { features: [['a drainage hole', 'فتحة تصريف']] };
}

function buildPenHolder(b, rnd, ctx) {
  const { sf, hf, wf, P } = ctx;
  let styles = ctx.styles;
  const castle = styles.includes('castle') || styles.includes('tower');
  const dragon = styles.includes('dragon');
  const withHandle = P.has('handle') || dragon;
  if (!styles.some((s) => ['star', 'flower', 'gear', 'wavy', 'hexagon', 'faceted', 'castle', 'tower'].includes(s))) {
    const pickStyle = rnd.pick(['hexagon', 'wavy', 'round', 'faceted', 'flower']);
    if (pickStyle !== 'round') styles = [...styles, pickStyle];
  }
  // A handle needs a fixed attachment angle, so no twist on handled bodies.
  if (withHandle) styles = styles.filter((s) => s !== 'twisted' && s !== 'spiral');
  const R0 = rnd.range(36, 40) * sf * wf;
  const waist = rnd.range(-0.05, 0.04);
  const corbel = castle ? rnd.range(1.5, 2.5) : 0;
  const R = (t) => R0 * (1 + waist * Math.sin(Math.PI * t)) + corbel * smoothstep(0.8, 0.88, t);
  const H = limitSlope(rnd.range(95, 108) * sf * hf, R);
  const castleLift = castle ? { m: rnd.int(7, 10), h: rnd.range(6, 9) * sf } : null;
  const st = bodyStyle(styles.filter((s) => s !== 'dragon'), rnd, H, { castleLift, baseSegments: 144 });
  const zTopF = rnd.range(0.68, 0.74), zBotF = rnd.range(0.24, 0.3);
  const radius = rnd.range(4.2, 4.8);
  let opts = st.opts;
  let innerSection;
  if (withHandle) {
    innerSection = st.opts.section;
    const Rz = (z) => R(clamp(z / H, 0, 1));
    opts = { ...st.opts, section: spineSection(innerSection, Rz, { angle: 0, amp: 5.5, halfWidth: 0.4, zLo: H * zBotF - 12, zHi: H * zTopF + 12 }) };
  }
  const v = vesselProfile({ H, R, wall: 3, floor: 4, samples: st.samples, liftRim: !!castleLift, innerSection });
  latheVessel(b, v, opts);
  if (withHandle) {
    vesselHandle(b, rnd, v, opts, {
      H, zTopF, zBotF, depth: rnd.range(20, 25) * sf, radius, style: rnd.pick(['bezier', 'loop', 'angular']), dragon, sf,
    });
  }
  ctx.styles = styles; // auto-picked style shows in the title
  return { extra: { handle: withHandle, dragonHandle: withHandle && dragon, castleShape: castle } };
}

function buildLamp(b, rnd, ctx) {
  const { sf, hf, wf } = ctx;
  let styles = ctx.styles;
  if (!styles.some((s) => ['star', 'flower', 'gear', 'wavy', 'hexagon', 'faceted', 'castle', 'tower', 'twisted', 'spiral'].includes(s))) {
    styles = [...styles, rnd.pick(['wavy', 'flower', 'faceted']), 'twisted'];
    ctx.styles = styles;
  }
  const Hw = rnd.range(110, 130) * sf * hf;
  const Rb = rnd.range(68, 80) * sf * wf;
  const Rt = Math.max(40, rnd.range(42, 50) * sf * wf);
  const curve = rnd.pick(['cone', 'bell', 'drum']);
  const R = {
    cone: (t) => Rb + (Rt - Rb) * t,
    bell: (t) => Rt + (Rb - Rt) * Math.pow(1 - t, 1.6),
    drum: (t) => Rb * 0.92 + (Rt * 1.15 - Rb * 0.92) * t,
  }[curve];
  const st = bodyStyle(styles, rnd, Hw, { baseSegments: 160 });
  const wall = 2.8;
  const hole = 21, flangeR = hole + 1.2;
  const beta = (52 * Math.PI) / 180, tb = Math.tan(beta);
  const Rtop = R(1);
  const rise = (Rtop - flangeR) * tb;
  const H = Hw + rise;
  // Outer surface: the body up to Hw, then a 52° conical roof to the flange ring.
  const Rz = (z) => (z <= Hw ? R(clamp(z / Hw, 0, 1)) : Math.max(flangeR, Rtop - (z - Hw) / tb));
  const n = Math.max(st.samples, 30);
  const Pf = [];
  for (let i = 0; i <= n; i++) { const z = (Hw * i) / n; Pf.push({ r: Rz(z), z }); }
  const nr = 12;
  for (let i = 1; i <= nr; i++) { const z = Hw + (rise * i) / nr; Pf.push({ r: Rz(z), z }); }
  Pf.push({ r: hole, z: H - 1.2, section: sections.round });
  const z1 = H - (wall / Math.sin(beta) - 1.2) * tb; // where the inner roof meets the hole wall
  Pf.push({ r: hole, z: z1, section: sections.round });
  // Inner roof (offset `wall` from the outer roof), down to where it meets the inner wall.
  const z2 = Hw - (wall / Math.sin(beta) - wall) * tb;
  for (let i = 1; i < nr; i++) { const z = z1 + (z2 - z1) * (i / nr); Pf.push({ r: Rz(z), wall, z }); }
  for (let i = n; i >= 0; i--) { const z = Math.min(z2, (Hw * i) / n); Pf.push({ r: Rz(z), wall, z }); }
  lathe(b, Pf, { ...st.opts, outerR: Rz });
  return { features: [['a 42 mm opening for a standard E27 pendant cord set', 'فتحة 42 مم لتركيب مصباح E27 قياسي'], ['a conical top', 'قمة مخروطية']] };
}

function buildTrophy(b, rnd, ctx) {
  const { sf, hf } = ctx;
  const s = Math.max(0.6, sf);
  const wall = 2.8 / s;
  const a = rnd.range(24, 28);
  const sq = sections.superellipse(a, a, rnd.range(4, 8));
  const tier = rnd.range(3.5, 5);
  const stemH = rnd.range(26, 34) * hf;
  const P = [
    { r: 0, z: 0 }, { r: 1, inset: 0.8, z: 0, section: sq }, { r: 1, z: 1, section: sq }, { r: 1, z: 10.5, section: sq },
    ...filletRings(1, 12.2, 1.5, 4, { section: sq }), { r: 1, inset: tier, z: 12.2, section: sq }, { r: 1, inset: tier, z: 18.5, section: sq },
    ...filletRings(1, 20.2, 1.5, 4, { section: sq }).map((p) => ({ ...p, inset: p.inset + tier })), { r: 7.5, z: 20.2 },
  ];
  const z0 = 20.2;
  P.push({ r: 5, z: z0 + 7 }, { r: 5, z: z0 + 10 }, { r: 8.5, z: z0 + 14 }, { r: 8.5, z: z0 + 16 }, { r: 5, z: z0 + 20 }, { r: 5, z: z0 + stemH });
  const zc = z0 + stemH;
  const cupR = rnd.range(27, 32);
  const zs = [zc, zc + 7, zc + 16, zc + 26, zc + 38, zc + 48];
  const rs = [5, 11, 19, cupR * 0.86, cupR * 0.98, cupR];
  const Rc = pchip(zs, rs);
  const zTopCup = zc + 48;
  const n = 36;
  for (let i = 1; i <= n; i++) { const z = zc + ((zTopCup - zc) * i) / n; P.push({ r: Rc(z), z }); }
  for (let k = 1; k < 8; k++) {
    const t = (Math.PI * k) / 8;
    P.push({ r: Rc(zTopCup), wall: (wall * (1 - Math.cos(t))) / 2, z: zTopCup + (wall / 2) * Math.sin(t) });
  }
  const floorZ = zc + 22;
  for (let i = n; i >= 0; i--) { const z = floorZ + 1.5 + ((zTopCup - floorZ - 1.5) * i) / n; P.push({ r: Rc(z), wall, z }); }
  P.push({ r: Rc(floorZ), wall, inset: 1.5, z: floorZ }, { r: 0, z: floorZ });
  const RzCup = (z) => Rc(clamp(z, zc, zTopCup));
  const hTop = zTopCup - 7, hBot = zc + 25;
  const spine0 = spineSection(sections.round, RzCup, { angle: 0, amp: 4.5, halfWidth: 0.42, zLo: hBot - 10, zHi: hTop + 8, ramp: 7 });
  const spine = spineSection(spine0, RzCup, { angle: Math.PI, amp: 4.5, halfWidth: 0.42, zLo: hBot - 10, zHi: hTop + 8, ramp: 7 });
  for (const q of P) if (q.wall !== undefined || q.z < zc) q.section = q.section ?? sections.round;
  const opts = { segments: 128, outerR: (z) => (z >= zc ? Rc(z) : 5), section: spine };
  lathe(b, P, opts);
  const v = { Rz: RzCup };
  for (const ang of [0, Math.PI]) {
    vesselHandle(b, rnd, v, opts, {
      H: 1, zTopF: hTop, zBotF: hBot, depth: rnd.range(8, 11), radius: 3.6,
      style: 'loop', dragon: false, sf: 1, angle: ang,
    });
  }
  return { scaleAfter: s };
}

function buildRocket(b, rnd, ctx) {
  const { hf } = ctx;
  const R = rnd.range(11, 13);
  const bodyTop = rnd.range(58, 68) * hf;
  const nose = rnd.range(30, 40);
  const band = rnd.range(30, bodyTop - 14);
  const P = [
    { r: 0, z: 0 }, { r: R * 0.72, z: 0 }, { r: R * 0.6, z: 4 }, { r: R * 0.92, z: 9.5 }, { r: R, z: 13 },
    { r: R, z: band }, { r: R + 1, z: band + 1.5 }, { r: R + 1, z: band + 4 }, { r: R, z: band + 5.5 }, { r: R, z: bodyTop },
  ];
  const ogive = (t) => R * Math.sqrt(Math.max(0, 1 - t * t));
  for (let i = 1; i < 14; i++) { const t = i / 14; P.push({ r: Math.max(1.6, ogive(t)), z: bodyTop + nose * t }); }
  P.push({ r: 1.6, z: bodyTop + nose + 0.8 }, { r: 0, z: bodyTop + nose + 1.2 });
  lathe(b, P, { segments: 120 });
  const fins = rnd.int(3, 4);
  const span = rnd.range(24, 30), finH = rnd.range(36, 46), sweep = rnd.range(4, 8);
  const root = R * 0.55; // fins reach deep into the body, so the joint is solid
  const poly = roundCorners([[root, 0], [span, 0], [span, sweep], [R + 2, finH * 0.82], [root, finH]], 2.5, 4);
  for (let k = 0; k < fins; k++) {
    const ph = (TAU * k) / fins;
    const c = Math.cos(ph), s = Math.sin(ph);
    extrudeChamfer(b, poly, -2.1, 2.1, 0.6, (u, v, w) => [u * c - w * s, u * s + w * c, v], { about: [root, 0] });
  }
  return { scaleAfter: ctx.sf };
}

// Castle tower as a lathe (rounded crenellations or a conical roof), placed at (x, y).
function towerLathe(b, rnd, x, y, R, H, { roof, m, mh, section, segments, plinth = 0, twist }) {
  const P = [{ r: 0, z: 0 }];
  if (plinth) {
    P.push({ r: R + plinth, inset: 0.8, z: 0 }, { r: R + plinth, z: 1 }, { r: R + plinth, z: 6 }, { r: R, z: 6 + plinth });
  } else P.push({ r: R, inset: 0.8, z: 0 }, { r: R, z: 1 });
  P.push({ r: R, z: H }, { r: R + 2.2, z: H + 3 }, { r: R + 2.2, z: H + 5 });
  if (roof) {
    const rh = roof;
    for (let i = 1; i < 10; i++) { const t = i / 10; P.push({ r: (R + 2.2) * (1 - t) * (1 - 0.15 * Math.sin(Math.PI * t)), z: H + 5 + rh * t }); }
    P.push({ r: 0, z: H + 5 + rh });
    lathe(b, P, { segments: segments || 96, section, twist, transform: xf.translate(x, y, 0) });
    return H + 5 + rh;
  }
  const wall = 3.2;
  P.push({ r: R + 2.2, z: H + 5.6 - wall / 2, lift: true });
  for (let k = 1; k < 8; k++) {
    const a = (Math.PI * k) / 8;
    P.push({ r: R + 2.2, inset: (wall * (1 - Math.cos(a))) / 2, z: H + 5.6 - wall / 2 + (wall / 2) * Math.sin(a), lift: true });
  }
  P.push({ r: R + 2.2, inset: wall, z: H + 5.6 - wall / 2, lift: true }, { r: R + 2.2, inset: wall, z: H + 3.6 }, { r: R + 2.2, inset: wall + 1, z: H + 2.8 }, { r: 0, z: H + 2.8 });
  lathe(b, P, { segments: segmentsFor(segments || 120, 2 * m), section, twist, lift: merlonLift(m, mh), transform: xf.translate(x, y, 0) });
  return H + 5.6 + mh;
}

// Crenellated wall outline in (u along the wall, v up), with rounded corners.
function crenellatedOutline(len, wallH, mw, mh) {
  const count = Math.max(2, Math.floor(len / (mw * 2)));
  const pts = [[-len / 2, 0], [len / 2, 0], [len / 2, wallH]];
  const pitch = len / count;
  for (let k = count - 1; k >= 0; k--) {
    const c = -len / 2 + pitch * (k + 0.5);
    pts.push([c + mw / 2, wallH], [c + mw / 2, wallH + mh], [c - mw / 2, wallH + mh], [c - mw / 2, wallH]);
  }
  pts.push([-len / 2, wallH]);
  return roundCorners(pts, Math.min(1.5, mw * 0.3), 3);
}

function buildCastle(b, rnd, ctx) {
  const { sf, hf, styles } = ctx;
  const S = rnd.range(92, 108) * sf;
  const tR = rnd.range(11.5, 13.5) * sf;
  const Ht = rnd.range(62, 80) * sf * hf;
  const wallH = Ht * rnd.range(0.55, 0.65);
  const wallT = 7 * sf;
  const c = S / 2 - tR - 2.5;
  const faceted = styles.includes('faceted') || styles.includes('hexagon');
  const section = faceted ? sections.roundedPolygon(styles.includes('hexagon') ? 6 : 8, 12) : undefined;
  const segs = faceted ? (styles.includes('hexagon') ? 72 : 96) : 96;
  // Base plate with rounded corners and a soft top edge.
  lathe(b, [
    { r: 0, z: 0 }, { r: 1, inset: 0.8, z: 0 }, { r: 1, z: 0.9 }, { r: 1, z: 4 * sf - 1.5 }, ...filletRings(1, 4 * sf, 1.5, 4), { r: 0, z: 4 * sf },
  ], { segments: 192, section: sections.superellipse(S / 2, S / 2, 8) });
  const roofs = rnd.chance(0.5);
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    towerLathe(b, rnd, sx * c, sy * c, tR, Ht, { roof: roofs ? rnd.range(16, 22) * sf : 0, m: rnd.int(5, 7), mh: 4 * sf, section, segments: segs });
  }
  // Curtain walls: one chamfered extrusion each, ending just inside the towers.
  const mw = 5 * sf, mh = 4.5 * sf;
  const len = 2 * c; // walls run from tower centre to tower centre
  const outline = crenellatedOutline(len, wallH, mw, mh);
  for (const [axis, pos] of [['x', -c], ['x', c], ['y', -c], ['y', c]]) {
    const map = axis === 'x' ? (u, v, w) => [u, pos + w, v] : (u, v, w) => [pos + w, u, v];
    extrudeChamfer(b, outline, -wallT / 2, wallT / 2, 1.0, map);
  }
  // Gate: an arched door standing proud of the front wall.
  const gw = 9 * sf, gh = Math.min(wallH * 0.55, 20 * sf);
  const arch = [[-gw, 0], [gw, 0], [gw, gh]];
  for (let i = 1; i < 12; i++) { const a = (Math.PI * i) / 12; arch.push([gw * Math.cos(a), gh + gw * Math.sin(a)]); }
  arch.push([-gw, gh]);
  extrudeChamfer(b, arch, -c - wallT / 2 - 2.6, -c + wallT / 2 - 2.2, 0.8, (u, v, w) => [u, w, v], { ends: 'start' });
  // Keep
  if (rnd.chance(0.5)) {
    const k = S * rnd.range(0.16, 0.2);
    const Hk = Ht * rnd.range(1.1, 1.3);
    lathe(b, [
      { r: 0, z: 0 }, { r: 1, inset: 0.8, z: 0 }, { r: 1, z: 1 }, { r: 1, z: Hk }, { r: 1, inset: -2, z: Hk + 2.5 }, { r: 1, inset: -2, z: Hk + 3.5 },
      ...filletRings(1, Hk + 5.2, 1.6, 4, { lift: true }).map((p) => ({ ...p, inset: p.inset - 2 })),
      { r: 1, inset: 1.6, z: Hk + 5.2, lift: true }, { r: 1, inset: 1.6, z: Hk + 2.5 }, { r: 0, z: Hk + 2.5 },
    ], { segments: segmentsFor(160, 16), section: sections.superellipse(k, k, 8), lift: merlonLift(8, mh) });
  } else {
    towerLathe(b, rnd, 0, 0, S * 0.17, Ht * rnd.range(1.15, 1.35), { roof: rnd.range(22, 30) * sf, m: 8, mh: 4 * sf, section, segments: segs });
  }
  return { features: [['four corner towers', 'أربعة أبراج ركنية'], ['rounded battlements', 'أسوار مسننة مستديرة'], ['an arched gate', 'بوابة مقوسة']] };
}

function buildTower(b, rnd, ctx) {
  const { sf, hf, styles } = ctx;
  const R = rnd.range(19, 23) * sf * ctx.wf;
  const H = rnd.range(95, 115) * sf * hf;
  const faceted = styles.includes('faceted') || styles.includes('hexagon') || rnd.chance(0.35);
  const n = styles.includes('hexagon') ? 6 : rnd.int(7, 10);
  const section = faceted ? sections.roundedPolygon(n, 12) : undefined;
  const st = bodyStyle(styles.filter((s) => s === 'twisted' || s === 'spiral'), rnd, H);
  const roof = rnd.chance(0.5) ? rnd.range(28, 40) * sf : 0;
  const m = rnd.int(6, 9);
  towerLathe(b, rnd, 0, 0, R, H, {
    roof, m, mh: 6 * sf, section, plinth: 3.5, twist: st.opts.twist,
    segments: faceted ? segmentsFor(120, n, roof ? 1 : 2 * m) : 120,
  });
  return { features: roof ? [['a pointed roof', 'سقف مدبب']] : [['rounded battlements', 'شرفات مستديرة']] };
}

function buildOrnament(b, rnd, ctx) {
  const { sf, styles } = ctx;
  const R = rnd.range(28, 34) * Math.max(0.7, sf);
  const shape = rnd.pick(['sphere', 'onion', 'drop']);
  const a0 = (-42 * Math.PI) / 180;
  const cz = -R * Math.sin(a0);
  const P = [{ r: 0, z: 0 }];
  let zCap;
  // Lower part plain and ≥ 48° so it prints clean; ribs only above the equator.
  if (shape === 'sphere') {
    for (let i = 0; i <= 20; i++) { const a = a0 + ((75 * Math.PI) / 180 - a0) * (i / 20); P.push({ r: R * Math.cos(a), z: cz + R * Math.sin(a), section: a < 0.05 ? sections.round : undefined }); }
    zCap = cz + R * Math.sin((75 * Math.PI) / 180);
  } else {
    for (let i = 0; i <= 12; i++) { const a = a0 + (0 - a0) * (i / 12); P.push({ r: R * Math.cos(a), z: cz + R * Math.sin(a), section: sections.round }); }
    const top = shape === 'onion' ? R * 1.25 : R * 1.6;
    const pinch = shape === 'onion' ? 2.2 : 1.4;
    for (let i = 1; i <= 14; i++) {
      const t = i / 14;
      P.push({ r: Math.max(6, R * Math.pow(1 - t, pinch) + 6 * t), z: cz + top * t });
    }
    zCap = cz + top;
  }
  P.push({ r: 6, z: zCap + 1 }, { r: 6, z: zCap + 5 }, { r: 5.2, z: zCap + 6.5 }, { r: 0, z: zCap + 6.5 });
  const st = bodyStyle(styles, rnd, zCap, { baseSegments: 128 });
  for (const p of P) if (p.z >= zCap) p.section = sections.round;
  lathe(b, P, st.opts);
  // Hanging loop: an arch with two legs that taper off inside the cap (no flat buried ends).
  const zc = zCap + 6.5, rm = 3.4, rt = 1.5;
  const loop = [];
  for (let k = 0; k <= 4; k++) loop.push([-rm, 0, zc - 4 + k]);
  for (let k = 1; k < 24; k++) { const a = Math.PI * (1 - k / 24); loop.push([rm * Math.cos(a), 0, zc + rm * Math.sin(a)]); }
  for (let k = 0; k <= 4; k++) loop.push([rm, 0, zc - k]);
  const nL = loop.length;
  tube(b, loop, (t, i) => (i < 3 ? 0.4 + (rt - 0.4) * (i / 3) : i > nL - 4 ? 0.4 + (rt - 0.4) * ((nL - 1 - i) / 3) : rt), { keel: true, seg: 18 });
  return { features: [['a hanging loop', 'حلقة تعليق']] };
}

function buildDragonEgg(b, rnd, ctx) {
  const { sf, hf } = ctx;
  const Re = rnd.range(26, 31) * sf;
  const He = Re * rnd.range(2.95, 3.25) * hf;
  const k = rnd.range(0.08, 0.14);
  const r = (t) => Re * Math.sqrt(Math.max(0, 1 - t * t)) * (1 - k * t);
  const z = (t) => ((t + 1) / 2) * He;
  let t0 = -0.99;
  for (let t = -0.99; t < 0; t += 0.002) {
    const dr = r(t + 0.001) - r(t - 0.001), dz = z(t + 0.001) - z(t - 0.001);
    if (dr / dz <= 0.9) { t0 = t; break; }
  }
  const zs0 = z(t0);
  const P = [{ r: 0, z: 0 }];
  for (let i = 0; i <= 80; i++) { const t = t0 + (0.985 - t0) * (i / 80); P.push({ r: r(t), z: z(t) - zs0 }); }
  P.push({ r: 0, z: z(1) - zs0 });
  const Hegg = z(1) - zs0;
  // Scales only on the upper half (fading in), so the lower belly stays smooth and support-free.
  const sc = sections.scales(rnd.int(14, 22), rnd.range(7, 10), 0.035);
  const egg = { segments: 176, section: (th, zz) => 1 + (sc(th, zz) - 1) * smoothstep(0.42 * Hegg, 0.56 * Hegg, zz) };
  lathe(b, P, egg);
  // Stand: a solid ring whose inner side follows the egg (0.3 mm inside it), with blunt rounded petals.
  const zr = 8 * Math.max(0.8, sf);
  const eggR = (zz) => { let best = Re; for (let t = t0; t < 0.9; t += 0.002) if (z(t) - zs0 >= zz) { best = r(t); break; } return best; };
  const ro = Re + 5 * Math.max(0.8, sf);
  const petals = rnd.int(5, 7);
  const ph = rnd.range(8, 11) * sf;
  const prof = [{ r: eggR(0) - 2.5, z: 0 }, { r: ro, inset: 0.8, z: 0 }, { r: ro, z: 1 }, { r: ro, z: zr - 1.5 }];
  for (let kk = 1; kk <= 5; kk++) { const a = (Math.PI / 2) * (kk / 5); prof.push({ r: ro, inset: 1.5 * (1 - Math.cos(a)), z: zr - 1.5 + 1.5 * Math.sin(a), lift: true }); }
  prof.push({ r: ro, inset: 4.5, z: zr, lift: true }, { r: ro, inset: 6, z: zr - 1.5, lift: true });
  for (let i = 4; i >= 1; i--) { const zz = (zr - 1.5) * (i / 5); prof.push({ r: eggR(zz) - 2.5, z: zz }); }
  lathe(b, prof, { segments: segmentsFor(144, petals), lift: crownLift(petals, ph) });
  return { features: [['a dragon-scale texture', 'ملمس حراشف التنين'], ['a petal stand', 'قاعدة بتلات مستديرة']] };
}

// Abstract sculpture: a solid, twisted organic column (no supports, nothing thin).
function buildSculpture(b, rnd, ctx) {
  const { sf, hf, styles } = ctx;
  const H = rnd.range(90, 120) * sf * hf;
  const R0 = rnd.range(24, 30) * sf;
  const lobes = rnd.int(3, 5);
  const amp = rnd.range(0.18, 0.28);
  const twistTotal = rnd.range(1.4, 2.6) * rnd.sign();
  const faceted = styles.includes('faceted');
  const base = faceted ? sections.roundedPolygon(lobes, 7) : sections.flower(lobes, amp);
  const waves = [];
  for (let k = 0; k < 3; k++) waves.push({ f: rnd.range(1.5, 3), p: rnd.range(0, TAU), a: rnd.range(0.02, 0.05) });
  const bulge = (z) => 1 + waves.reduce((s, w) => s + w.a * Math.sin((w.f * TAU * z) / H + w.p), 0);
  const Rz = (t) => R0 * (1.05 - 0.55 * t * t) * bulge(t * H);
  const P = [{ r: 0, z: 0 }, { r: Rz(0), inset: 0.8, z: 0 }];
  const n = 56;
  for (let i = 0; i <= n; i++) { const t = i / n; P.push({ r: Rz(t), z: 1.1 + (H - 1.1 - 6) * t }); }
  // rounded top
  for (let kk = 1; kk <= 6; kk++) { const a = (Math.PI / 2) * (kk / 6); P.push({ r: Rz(1) * Math.cos(a), z: H - 6 + 6 * Math.sin(a) }); }
  P.push({ r: 0, z: H });
  lathe(b, P, { segments: segmentsFor(160, lobes), section: base, twist: (z) => (twistTotal * z) / H });
  return { features: [[`${lobes} flowing lobes`, `${lobes} فصوص انسيابية`], ['a gentle twist', 'التفاف لطيف']] };
}

// ---------- chess ----------

function chessBase(Rb) {
  return [
    { r: 0, z: 0 }, { r: Rb, inset: 0.8, z: 0 }, { r: Rb, z: 1 }, { r: Rb, z: 3.5 }, { r: Rb - 1.5, z: 5 }, { r: Rb - 1.5, z: 5.8 },
    { r: Rb - 0.7, z: 6.8 }, { r: Rb - 1.6, z: 8.2 }, { r: Rb - 3.5, z: 9.5 },
  ];
}

function arcPts(cz, R, a0, a1, n) {
  const out = [];
  for (let i = 1; i < n; i++) { const a = a0 + (a1 - a0) * (i / n); out.push({ r: R * Math.cos(a), z: cz + R * Math.sin(a) }); }
  return out;
}

function pawnProfile() {
  const cz = 28 + Math.sqrt(8.6 * 8.6 - 6.4 * 6.4);
  return [
    ...chessBase(14), { r: 8.6, z: 13 }, { r: 7, z: 18 }, { r: 6.2, z: 22 }, { r: 9.2, z: 25.5 }, { r: 9.2, z: 26.5 }, { r: 6.4, z: 28 },
    ...arcPts(cz, 8.6, Math.asin((28 - cz) / 8.6), Math.PI / 2, 20), { r: 0, z: cz + 8.6 },
  ];
}

// Superellipse outline in the xy plane: half-axes a (x), centre cx; the half-width is `wf` at the
// front (+x) blending to `wb` at the back (−x). `mane` raises a ridge on the back side; `dents` are
// shallow sockets [angle, depth, width] cut into the outline.
function sliceOutline(cx, a, wf, p, segs, mane = 0, dents = [], wb = wf) {
  const pts = [];
  for (let j = 0; j < segs; j++) {
    const th = (TAU * j) / segs;
    const c = Math.abs(Math.cos(th)), s = Math.abs(Math.sin(th));
    const bb = wb + (wf - wb) * (1 + Math.cos(th)) / 2;
    let r = Math.pow(Math.pow(c / a, p) + Math.pow(s / bb, p), -1 / p);
    for (const [ang, depth, width] of dents) {
      let d = th - ang;
      while (d > Math.PI) d -= TAU;
      while (d < -Math.PI) d += TAU;
      r -= depth * Math.exp(-((d / width) ** 2));
    }
    let x = cx + r * Math.cos(th), y = r * Math.sin(th);
    if (mane > 0) {
      const back = Math.abs(((th - Math.PI + Math.PI) % TAU) - Math.PI); // angle from the back direction
      const g = Math.exp(-((back / 0.42) ** 2));
      x -= mane * g;
    }
    pts.push([x, y, 0]);
  }
  return pts;
}

// Staunton-style knight: a horse head on an arched neck, built from horizontal slices so that no
// surface leans more than ~45° (prints without supports). Read in the side view: the neck rises
// from the collar, the throat curves in, the jaw and muzzle jut forward, the nose bridge climbs
// back to the forehead, and the ears sit at the top-back above a mane ridge.
function knightHead(b, rnd) {
  const segs = 56;
  const jut = rnd.range(0.94, 1.0);       // how far the muzzle reaches forward
  const maneH = rnd.range(2.2, 3.0);
  const keys = [
    // z, front x, back x, half-width front, half-width back, mane
    [0, 7.5, -7.5, 7.2, 7.2, 0],
    [8, 6.8, -8.2, 6.6, 7.0, 0.6],
    [14, 6.4, -9.6, 6.0, 6.8, maneH * 0.8],      // neck: narrowest at the throat
    [19, 7.6, -10.8, 6.0, 6.9, maneH],
    [23, 11.0, -11.4, 6.8, 7.1, maneH],          // throat → jaw
    [27, 14.4 * jut, -11.5, 7.6, 7.2, maneH],    // jaw (cheeks are the widest part)
    [30, 17.0 * jut, -11.2, 7.3, 7.0, maneH * 0.9],
    [33, 18.8 * jut, -10.6, 6.3, 6.6, maneH * 0.8], // muzzle: narrower than the cheeks
    [36, 18.6 * jut, -9.6, 5.9, 6.2, maneH * 0.7],
    [39, 14.6, -8.2, 5.9, 5.9, maneH * 0.6],     // nose bridge rising to the forehead
    [42, 9.2, -6.2, 5.4, 5.2, maneH * 0.4],
    [44.5, 3.6, -3.6, 3.8, 3.6, 0],              // poll
    [45.6, 1.0, -1.0, 1.4, 1.4, 0],
  ];
  const zs = keys.map((k) => k[0]);
  const col = (i) => pchip(zs, keys.map((k) => k[i]));
  const F = col(1), B = col(2), WF = col(3), WB = col(4), M = col(5);
  const top = zs[zs.length - 1];
  const rings = [];
  for (let z = 0; z <= top + 1e-9; z += z < 8 ? 4 : 0.7) {
    const zz = Math.min(z, top);
    const f = F(zz), bk = B(zz);
    // eye sockets on the cheeks, nostrils at the muzzle tip and a mouth line under it
    const eye = 1.2 * Math.exp(-(((zz - 36.5) / 2.0) ** 2));
    const nostril = 0.8 * Math.exp(-(((zz - 34) / 1.3) ** 2));
    const mouth = 0.6 * Math.exp(-(((zz - 29.5) / 0.7) ** 2));
    const dents = [[0.75, eye, 0.28], [-0.75, eye, 0.28], [0.2, nostril, 0.15], [-0.2, nostril, 0.15], [0, mouth, 0.5]];
    const pts = sliceOutline((f + bk) / 2, Math.max(0.6, (f - bk) / 2), Math.max(0.6, WF(zz)), 2.5, segs, M(zz), dents, Math.max(0.6, WB(zz)));
    rings.push(pts.map((p) => [p[0], p[1], zz]));
  }
  loft(b, rings, { endCap: [0, 0, top + 0.9] });
  // ears at the top-back, leaning back a little
  for (const s of [-1, 1]) {
    const tilt = xf.compose(xf.rotX(s * 0.25), (x, y, z) => [x * Math.cos(-0.4) - z * Math.sin(-0.4), y, x * Math.sin(-0.4) + z * Math.cos(-0.4)]);
    blob(b, [-1.4, s * 3.1, 44.4], 2.4, 1.8, 5.4, tilt, 2);
  }
}

// King cross: a rounded cross with 45°+ undersides, its stem buried in the dome.
function kingCross(b) {
  const pts = [
    [0, 56.2], [2.4, 59.2], [2.4, 64], [6.4, 68.6], [6.4, 71.6], [2.4, 71.6], [2.4, 76.4], [-2.4, 76.4], [-2.4, 71.6], [-6.4, 71.6], [-6.4, 68.6], [-2.4, 64], [-2.4, 59.2],
  ];
  extrudeChamfer(b, roundCorners(pts, 1.0, 3), -2.4, 2.4, 0.9, (u, v, w) => [u, w, v], { about: [0, 66] });
}

const CHESS = {
  pawn: { scale: 1.15, Rb: 14, build: (b, o) => lathe(b, pawnProfile(), o) },
  rook: {
    scale: 1.25, Rb: 15,
    build: (b, o, rnd) => {
      const m = rnd.int(4, 6);
      const wall = 3.6;
      const P = [
        ...chessBase(15), { r: 10.2, z: 14 }, { r: 9.6, z: 22 }, { r: 9.4, z: 29 }, { r: 12.2, z: 32.5 }, { r: 12.2, z: 40.2, lift: true },
      ];
      for (let k = 1; k < 8; k++) { const a = (Math.PI * k) / 8; P.push({ r: 12.2, inset: (wall * (1 - Math.cos(a))) / 2, z: 40.2 + (wall / 2) * Math.sin(a), lift: true }); }
      P.push({ r: 12.2, inset: wall, z: 40.2, lift: true }, { r: 12.2, inset: wall, z: 38.5 }, { r: 12.2, inset: wall + 1.2, z: 37.3 }, { r: 0, z: 37.3 });
      lathe(b, P, { ...o, segments: segmentsFor(o.segments, 2 * m), lift: merlonLift(m, 5, 0.55, 0.14) });
    },
  },
  knight: {
    scale: 1.25, Rb: 14,
    build: (b, o, rnd) => {
      lathe(b, [...chessBase(14), { r: 10, z: 10.5 }, { r: 9.4, z: 11 }, { r: 0, z: 11 }], o);
      knightHead(b, rnd);
    },
  },
  bishop: {
    scale: 1.15, Rb: 14,
    build: (b, o) => {
      const mz = [32.6, 36, 40, 44, 48.5, 52.5, 55.5], mr = [6, 8.2, 9, 8.6, 7, 4.6, 2.2];
      const f = pchip(mz, mr);
      const mitre = [];
      // vertical slit groove on the front and back of the mitre, deeper towards the top
      const groove = (th, z) => {
        const d = Math.min(Math.abs(th - Math.PI / 2), Math.abs(th - (3 * Math.PI) / 2));
        return 1 - 0.14 * smoothstep(35, 48, z) * Math.exp(-((d / 0.16) ** 2));
      };
      for (let i = 1; i <= 24; i++) { const z = 32.6 + (55.5 - 32.6) * (i / 24); mitre.push({ r: f(z), z, section: groove }); }
      const cz = 55.5 + Math.sqrt(9 - 2.2 * 2.2);
      lathe(b, [
        ...chessBase(14), { r: 9, z: 13 }, { r: 6.6, z: 20 }, { r: 5.5, z: 26 }, { r: 8.8, z: 30 }, { r: 8.8, z: 31 }, { r: 6, z: 32.6 },
        ...mitre, ...arcPts(cz, 3, Math.asin(-2.04 / 3), Math.PI / 2, 10), { r: 0, z: cz + 3 },
      ], { ...o, segments: Math.max(o.segments, 144) });
    },
  },
  queen: {
    scale: 1.4, Rb: 15.5,
    build: (b, o, rnd) => {
      const m = rnd.int(7, 9);
      const dome = [];
      for (let i = 0; i <= 6; i++) { const a = (50 * Math.PI) / 180 * (i / 6); dome.push({ r: 5.5 * Math.cos(a), z: 47.5 + 5.5 * Math.sin(a) }); }
      const jr = 5.5 * Math.cos((50 * Math.PI) / 180), jz = 47.5 + 5.5 * Math.sin((50 * Math.PI) / 180);
      const bc = jz + Math.sqrt(3.8 * 3.8 - jr * jr);
      const wall = 3.2;
      const P = [
        ...chessBase(15.5), { r: 10, z: 14 }, { r: 7.2, z: 24 }, { r: 6, z: 34 }, { r: 9.5, z: 38 }, { r: 9.5, z: 39 }, { r: 6.5, z: 41 },
        { r: 8.2, z: 44 }, { r: 10.5, z: 49 }, { r: 10.5, z: 50, lift: true },
      ];
      for (let k = 1; k < 8; k++) { const a = (Math.PI * k) / 8; P.push({ r: 10.5, inset: (wall * (1 - Math.cos(a))) / 2, z: 50 + (wall / 2) * Math.sin(a), lift: true }); }
      P.push({ r: 10.5, inset: wall, z: 50, lift: true }, { r: 10.5, inset: wall + 0.6, z: 47.5 }, ...dome,
        ...arcPts(bc, 3.8, Math.asin((jz - bc) / 3.8), Math.PI / 2, 10), { r: 0, z: bc + 3.8 });
      lathe(b, P, { ...o, segments: segmentsFor(o.segments, m), lift: crownLift(m, 4.5) });
    },
  },
  king: {
    scale: 1.2, Rb: 16,
    build: (b, o) => {
      lathe(b, [
        ...chessBase(16), { r: 10.5, z: 14 }, { r: 7.6, z: 26 }, { r: 6.5, z: 38 }, { r: 10, z: 42 }, { r: 10, z: 43 }, { r: 7, z: 45 },
        { r: 8.8, z: 48 }, { r: 11, z: 53 }, { r: 11, z: 55 }, { r: 10.2, z: 56.2 }, { r: 8.4, z: 57.8 }, { r: 5.5, z: 59 }, { r: 2.5, z: 59.6 }, { r: 0, z: 59.8 },
      ], o);
      kingCross(b);
    },
  },
};

function buildChessPiece(b, rnd, ctx, piece, at = [0, 0], sizeMul = 1) {
  const { styles } = ctx;
  const def = CHESS[piece];
  const s = def.scale * ctx.sf * sizeMul * rnd.range(0.97, 1.03);
  const H = 80;
  const st = bodyStyle(styles.filter((x) => !['castle', 'tower', 'dragon', 'star', 'flower', 'gear', 'faceted', 'hexagon'].includes(x)), rnd, H / def.scale, { baseSegments: 128 });
  const sub = new Builder();
  def.build(sub, { ...st.opts, lift: undefined }, rnd);
  const off = b.vcount;
  for (let i = 0; i < sub.pos.length; i += 3) b.pos.push(sub.pos[i] * s + at[0], sub.pos[i + 1] * s + at[1], sub.pos[i + 2] * s);
  for (const i of sub.idx) b.idx.push(i + off);
  return def.Rb * s;
}

function buildChess(b, rnd, ctx, piece) {
  if (piece !== 'set') {
    buildChessPiece(b, rnd, ctx, piece);
    return { piece };
  }
  const rows = [['king', 'queen', 'bishop'], ['knight', 'rook', 'pawn']];
  const gap = 6;
  rows.forEach((row, ri) => {
    const radii = row.map((p) => CHESS[p].Rb * CHESS[p].scale * ctx.sf);
    const width = radii.reduce((s, r) => s + 2 * r, 0) + gap * (row.length - 1);
    let x = -width / 2;
    const y = (ri === 0 ? 1 : -1) * (19 * ctx.sf + gap / 2) * 1.1;
    row.forEach((p, i) => {
      x += radii[i];
      buildChessPiece(b, rnd, ctx, p, [x, y]);
      x += radii[i] + gap;
    });
  });
  return { piece: 'set' };
}

// ---------- flat things ----------

function starPoly(n, ro, ri, rot = Math.PI / 2) {
  const pts = [];
  for (let i = 0; i < 2 * n; i++) { const a = rot + (Math.PI * i) / n; const r = i % 2 ? ri : ro; pts.push([r * Math.cos(a), r * Math.sin(a)]); }
  return pts;
}

function heartPoly(s) {
  const pts = [];
  for (let i = 0; i < 60; i++) {
    const t = (TAU * i) / 60;
    pts.push([s * 16 * Math.sin(t) ** 3, s * (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t))]);
  }
  return pts;
}

function roundedRect(w, h, r, seg = 6) {
  const pts = [];
  const corners = [[w / 2 - r, -h / 2 + r, -Math.PI / 2], [w / 2 - r, h / 2 - r, 0], [-w / 2 + r, h / 2 - r, Math.PI / 2], [-w / 2 + r, -h / 2 + r, Math.PI]];
  for (const [cx, cy, a0] of corners) for (let i = 0; i <= seg; i++) { const a = a0 + (Math.PI / 2) * (i / seg); pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  return pts;
}

function buildKeychain(b, rnd, ctx) {
  const { P, sf } = ctx;
  const s = Math.max(0.7, Math.min(1.6, sf));
  let shape;
  if (P.has('heart')) shape = 'heart';
  else if (P.has('star')) shape = 'star';
  else if (P.has('hexagon')) shape = 'hexagon';
  else if (P.has('shield')) shape = 'shield';
  else if (P.has('circle')) shape = 'circle';
  else shape = rnd.pick(['rounded', 'circle', 'hexagon', 'shield', 'star', 'heart']);
  let poly;
  const sc = s * rnd.range(0.95, 1.08);
  switch (shape) {
    case 'heart': poly = roundCorners(heartPoly(1.5 * sc), 3 * sc, 4); break;
    case 'star': poly = roundCorners(starPoly(5, 24 * sc, 12.5 * sc), 3.2 * sc, 5); break;
    case 'hexagon': poly = roundCorners(Array.from({ length: 6 }, (_, i) => [23 * sc * Math.cos(Math.PI / 6 + (i * TAU) / 6), 23 * sc * Math.sin(Math.PI / 6 + (i * TAU) / 6)]), 4 * sc, 5); break;
    case 'shield': {
      poly = [[-18 * sc, 14 * sc], [-18 * sc, 0]];
      for (let i = 1; i < 12; i++) { const t = i / 12; poly.push([-18 * sc * (1 - t) ** 1.3, -22 * sc * Math.sin((Math.PI / 2) * t)]); }
      poly.push([0, -22 * sc]);
      for (let i = 11; i >= 1; i--) { const t = i / 12; poly.push([18 * sc * (1 - t) ** 1.3, -22 * sc * Math.sin((Math.PI / 2) * t)]); }
      poly.push([18 * sc, 0], [18 * sc, 14 * sc]);
      poly = roundCorners(poly, 3 * sc, 4);
      break;
    }
    case 'circle': poly = Array.from({ length: 48 }, (_, i) => [21 * sc * Math.cos((TAU * i) / 48), 21 * sc * Math.sin((TAU * i) / 48)]); break;
    default: poly = roundedRect(46 * sc, 28 * sc, 7 * sc);
  }
  const T = 4.5;
  const cx = poly.reduce((a, p) => a + p[0], 0) / poly.length, cy = poly.reduce((a, p) => a + p[1], 0) / poly.length;
  extrudeChamfer(b, poly, 0, T, 1.0, (u, v, w) => [u, v, w], { about: [cx, cy], ends: 'end' });
  const k = rnd.range(0.7, 0.78);
  extrudeChamfer(b, poly.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k]), 0, T + 2.2, 1.2, (u, v, w) => [u, v, w], { about: [cx, cy], ends: 'end' });
  // Loop for a split ring: thick, lying flat.
  const ymax = Math.max(...poly.map((p) => p[1]));
  const tops = poly.filter((p) => p[1] >= ymax - 0.8);
  const top = tops.reduce((best, p) => (Math.abs(p[0]) < Math.abs(best[0]) ? p : best), tops[0]);
  washer(b, [top[0], top[1] + 2.6, T / 2], [0, 0, 1], 5.8, 3.0, T / 2, 36);
  return { shape, features: [['a thick loop for a split ring', 'حلقة سميكة لتركيب سلسلة المفاتيح']] };
}

function buildPhoneStand(b, rnd, ctx) {
  const { sf } = ctx;
  const s = Math.max(0.8, Math.min(1.4, sf));
  const lean = rnd.range(14, 20) * Math.PI / 180;
  const supH = rnd.range(74, 86);
  const lip = rnd.range(18, 24);
  const x0 = 56, t = 10;
  const dx = Math.tan(lean) * supH;
  const poly = roundCorners([
    [0, 0], [82, 0], [82, 6], [x0, 6], [x0 + dx, supH], [x0 + dx - 4, supH + 3.5], [x0 + dx - t, supH + 1],
    [x0 - t - 3, 9], [16, 9], [16, lip - 3], [12, lip], [6, lip], [2, lip - 4], [0, 10],
  ].map(([x, z]) => [x * s - 41 * s, z * s]), 2.2 * s, 4);
  const W = rnd.range(66, 80) * s;
  extrudeChamfer(b, poly, -W / 2, W / 2, 1.4, (u, v, w) => [u, w, v]);
  return { features: [['a deep front lip', 'حافة أمامية عميقة'], ['softened edges', 'حواف ناعمة']] };
}

function buildOrganizer(b, rnd, ctx) {
  const { sf, hf, wf, P } = ctx;
  const trinket = P.has('trinket') || P.has('lid');
  const lid = P.has('lid') || trinket;
  const a = (trinket ? rnd.range(36, 42) : rnd.range(46, 56)) * sf * wf, bb = (trinket ? rnd.range(26, 30) : rnd.range(32, 38)) * sf;
  const H = (trinket ? rnd.range(32, 40) : rnd.range(45, 60)) * sf * hf;
  const p = rnd.range(4, 7);
  // Compartments are separate cells whose walls overlap, so every wall is solid and ≥ 3 mm.
  const cells = lid ? 1 : rnd.int(2, 3);
  const overlap = 1.2;
  const cellA = (2 * a + overlap * (cells - 1)) / (2 * cells);
  for (let i = 0; i < cells; i++) {
    const cx = -a + cellA + i * (2 * cellA - overlap);
    const v = vesselProfile({ H, R: () => 1, wall: 3, floor: 3.5, samples: 6 });
    lathe(b, v.profile, { segments: 176, section: sections.superellipse(cellA, bb, p), outerR: () => 1, transform: xf.translate(cx, 0, 0) });
  }
  const feats = [];
  if (lid) {
    const oy = 2 * bb + 12;
    const lidSq = sections.superellipse(a, bb, p);
    lathe(b, [{ r: 0, z: 0 }, { r: 1, inset: 0.8, z: 0 }, { r: 1, z: 1 }, { r: 1, z: 2.4 }, ...filletRings(1, 4, 1.6, 4), { r: 0, z: 4 }], { segments: 176, section: lidSq, transform: xf.translate(0, oy, 0) });
    const lipSq = sections.superellipse(a - 3.4, bb - 3.4, p);
    lathe(b, [{ r: 1, z: 0 }, { r: 1, z: 8.2 }, { r: 1, inset: 0.5, z: 9.2 }, { r: 1, inset: 3.0, z: 9.2 }, { r: 1, inset: 3.0, z: 0 }], { segments: 176, section: lipSq, transform: xf.translate(0, oy, 0) });
    feats.push(['a snug-fitting lid', 'غطاء محكم']);
  } else {
    feats.push([`${cells} compartments`, `${cells} أقسام`]);
  }
  return { features: feats, lid };
}

// Rounded slab from a superellipse: half sizes (a, b), height h, top fillet rho.
function slab(b, a, bb, h, rho, { p = 6, at = [0, 0], segments = 160, bottomChamfer = 0.8 } = {}) {
  const sq = sections.superellipse(a, bb, p);
  const P = [{ r: 0, z: 0 }, { r: 1, inset: bottomChamfer, z: 0 }, { r: 1, z: bottomChamfer * 1.3 }, { r: 1, z: h - rho }, ...filletRings(1, h, rho, 5), { r: 0, z: h }];
  lathe(b, P, { segments, section: sq, transform: xf.translate(at[0], at[1], 0) });
}

// Rounded post (cylinder with a domed top), optionally tilted; its first ring is the footprint on the bed.
function post(b, at, r, h, { tilt = 0, dir = [0, 1] } = {}) {
  const seg = 24;
  const axis = vnorm([Math.sin(tilt) * dir[0], Math.sin(tilt) * dir[1], Math.cos(tilt)]);
  const ref = Math.abs(axis[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const N = vnorm(vcross(ref, axis)), B = vcross(axis, N);
  const base = [at[0], at[1], 0];
  const circle = (s, rr) => Array.from({ length: seg }, (_, j) => {
    const t = (TAU * j) / seg;
    return vadd(vadd(base, vscale(axis, s)), vadd(vscale(N, rr * Math.cos(t)), vscale(B, rr * Math.sin(t))));
  });
  // footprint: the ring at s = 2r projected down the axis onto the bed (same point order as the rings above)
  const rings = [circle(2 * r, r).map((p) => vsub(p, vscale(axis, p[2] / axis[2])))];
  const L = h - r;
  for (const t of [0.35, 0.7, 1]) rings.push(circle(L * t, r));
  for (let k = 1; k <= 5; k++) { const a = (Math.PI / 2) * (k / 5); rings.push(circle(L + r * Math.sin(a), Math.max(0.3, r * Math.cos(a)))); }
  loft(b, rings, { endCap: vadd(base, vscale(axis, h)) });
}

function buildBookend(b, rnd, ctx) {
  const { sf, hf } = ctx;
  const s = Math.max(0.7, Math.min(1.5, sf));
  const W = rnd.range(80, 96) * s, D = rnd.range(60, 72) * s, H = rnd.range(95, 120) * s * hf;
  const baseH = 8 * s, upT = 12 * s;
  slab(b, W / 2, D / 2, baseH, 2.5 * s, { p: 7 });
  const uy = D / 2 - upT / 2 - 3 * s;
  // upright: a rounded slab stood on edge (superellipse 90 × 12), from the bed through the base
  const sq = sections.superellipse(W / 2 - 2 * s, upT / 2, 6);
  lathe(b, [{ r: 0, z: 0 }, { r: 1, inset: 0.8, z: 0 }, { r: 1, z: 1 }, { r: 1, z: H - 3 * s }, ...filletRings(1, H, 3 * s, 5), { r: 0, z: H }],
    { segments: 176, section: sq, transform: xf.translate(0, uy, 0) });
  // 50° gusset in the middle, buried 2.5 mm into the upright
  const gy = uy - upT / 2 + 2.5 * s;
  const run = rnd.range(24, 30) * s, rise = run * 1.2;
  const g = roundCorners([[gy - run, 0], [gy, 0], [gy, rise]], 2 * s, 4);
  extrudeChamfer(b, g, -6 * s, 6 * s, 1.2, (u, v, w) => [w, u, v]);
  return { features: [['a heavy base', 'قاعدة ثقيلة'], ['a tall rounded back', 'ظهر مرتفع مستدير'], ['a triangular brace', 'دعامة مثلثة']] };
}

function buildHeadphoneStand(b, rnd, ctx) {
  const { sf, hf } = ctx;
  const s = Math.max(0.8, Math.min(1.3, sf));
  const Htot = rnd.range(180, 200) * s * hf;
  const baseA = rnd.range(42, 48) * s, baseB = rnd.range(32, 36) * s, baseH = 7 * s;
  const stemR = rnd.range(9.5, 11) * s;
  const topA = rnd.range(32, 38) * s, topB = rnd.range(14, 17) * s;
  const flareH = (topA - stemR) / 0.84;
  const zFlare = Htot - 9 * s - flareH;
  const se = (a, bb, p) => sections.superellipse(a, bb, p);
  const P = [
    { r: 0, z: 0 }, { r: 1, inset: 0.8, z: 0, section: se(baseA, baseB, 6) }, { r: 1, z: 1, section: se(baseA, baseB, 6) },
    { r: 1, z: baseH - 2, section: se(baseA, baseB, 6) }, ...filletRings(1, baseH, 2, 4, { section: se(baseA, baseB, 6) }),
    { r: 1, z: baseH, section: se(stemR + 2, stemR + 2, 2) }, { r: 1, z: baseH + 2, section: se(stemR, stemR, 2) },
    { r: 1, z: zFlare, section: se(stemR, stemR, 2) },
  ];
  for (let i = 1; i <= 8; i++) {
    const t = i / 8;
    const a = stemR + (topA - stemR) * t, bb = stemR + (topB - stemR) * t, p = 2 + 2.5 * t;
    P.push({ r: 1, z: zFlare + flareH * t, section: se(a, bb, p) });
  }
  for (let k = 1; k <= 6; k++) {
    const a = (Math.PI / 2) * (k / 6);
    P.push({ r: 1, z: zFlare + flareH + 9 * s * Math.sin(a), section: se(Math.max(0.5, topA * Math.cos(a)), Math.max(0.5, topB * Math.cos(a)), 4.5) });
  }
  P.push({ r: 0, z: Htot });
  lathe(b, P, { segments: 160 });
  return { features: [['a wide saddle for the headband', 'قمة عريضة لحامل الرأس'], ['a weighted oval base', 'قاعدة بيضاوية ثابتة']] };
}

function buildHook(b, rnd, ctx) {
  const { sf } = ctx;
  const s = Math.max(0.7, Math.min(1.5, sf));
  const W = rnd.range(110, 130) * s, D = rnd.range(46, 54) * s, T = 6 * s;
  slab(b, W / 2, D / 2, T, 2 * s, { p: 8, segments: 192 });
  const n = rnd.int(3, 5);
  const r = 4.6 * s, h = rnd.range(20, 24) * s;
  for (let i = 0; i < n; i++) {
    const x = -W / 2 + (W / (n + 1)) * (i + 1);
    post(b, [x, -D * 0.12], r, h, { tilt: 0.33, dir: [0, 1] });
  }
  return { features: [[`${n} angled pegs`, `${n} أوتاد مائلة`], ['a flat back for adhesive strips or screws', 'ظهر مستوٍ للتثبيت بالشرائط اللاصقة أو البراغي']] };
}

function buildCable(b, rnd, ctx) {
  const { sf } = ctx;
  const s = Math.max(0.7, Math.min(1.5, sf));
  const n = rnd.int(4, 6);
  const gap = rnd.range(8, 10) * s, pr = 3.8 * s;
  const W = (n * 2 * pr + (n - 1) * gap + 14 * s), D = 24 * s;
  slab(b, W / 2, D / 2, 6 * s, 2 * s, { p: 6 });
  for (let i = 0; i < n; i++) {
    const x = -W / 2 + 7 * s + pr + i * (2 * pr + gap);
    post(b, [x, 0], pr, 15 * s);
  }
  return { features: [[`${n - 1} cable slots`, `${n - 1} فتحات للكابلات`], ['rounded posts', 'أعمدة مستديرة']] };
}

function buildDice(b, rnd, ctx) {
  const { sf } = ctx;
  const A = 12 * Math.max(0.8, Math.min(2, sf));
  const p = rnd.range(5, 7);
  const sq = sections.superellipse(A, A, p);
  const rho = 2.6 * (A / 12), depth = 1.0 * (A / 12), pipR = 2.4 * (A / 12), off = 5 * (A / 12);
  const H = 2 * A;
  const faces = {
    top: [[-off, -off], [-off, 0], [-off, off], [off, -off], [off, 0], [off, off]],   // 6
    bottom: [[0, 0]],                                                                // 1
    px: [[-off, -off], [off, off]],                                                 // 2  (x = +A, coords [y, z-A])
    py: [[-off, -off], [0, 0], [off, off]],                                         // 3
    nx: [[-off, -off], [-off, off], [off, -off], [off, off]],                       // 4
    ny: [[-off, -off], [-off, off], [0, 0], [off, -off], [off, off]],               // 5
  };
  const bump = (d) => (d < pipR ? 0.5 + 0.5 * Math.cos((Math.PI * d) / pipR) : 0);
  const sideSec = (th, z) => {
    const base = sq(th);
    const x = base * Math.cos(th), y = base * Math.sin(th);
    let g = 0;
    const zz = z - A;
    if (x > A - 0.8) for (const [u, v] of faces.px) g = Math.max(g, bump(Math.hypot(y - u, zz - v)));
    else if (x < -A + 0.8) for (const [u, v] of faces.nx) g = Math.max(g, bump(Math.hypot(y - u, zz - v)));
    else if (y > A - 0.8) for (const [u, v] of faces.py) g = Math.max(g, bump(Math.hypot(x - u, zz - v)));
    else if (y < -A + 0.8) for (const [u, v] of faces.ny) g = Math.max(g, bump(Math.hypot(x - u, zz - v)));
    return base - depth * g;
  };
  const lift = (th, ring) => {
    const x = ring.r * Math.cos(th), y = ring.r * Math.sin(th);
    const list = ring.z > A ? faces.top : faces.bottom;
    let g = 0;
    for (const [u, v] of list) g = Math.max(g, bump(Math.hypot(x - u, y - v)));
    return (ring.z > A ? -depth : depth) * g;
  };
  const P = [{ r: 0, z: 0, lift: true }];
  const flat = A - rho;
  for (let r = 0.9; r < flat; r += 0.7) P.push({ r, z: 0, lift: true, section: sections.round });
  P.push({ r: flat, z: 0, lift: true, section: sections.round });
  // bottom chamfer to the side faces (45°)
  P.push({ r: 1, inset: 1.3, z: 0.05 }, { r: 1, z: 1.7 });
  for (let z = 2.2; z < H - rho; z += 0.6) P.push({ r: 1, z, section: sideSec });
  P.push({ r: 1, z: H - rho, section: sideSec });
  // top fillet
  for (let k = 1; k <= 7; k++) { const a = (Math.PI / 2) * (k / 7); P.push({ r: 1, inset: rho * (1 - Math.cos(a)), z: H - rho + rho * Math.sin(a) }); }
  // top flat with dimples
  for (let r = flat - 0.3; r > 0.9; r -= 0.7) P.push({ r, z: H, lift: true, section: sections.round });
  P.push({ r: 0.9, z: H, lift: true, section: sections.round }, { r: 0, z: H, lift: true });
  lathe(b, P, { segments: 200, section: sq, lift, minR: 0.2 });
  return { features: [['recessed pips', 'نقاط غائرة'], ['softly rounded corners', 'زوايا مستديرة بنعومة']] };
}

// Smooth raised disc on a lathe surface: height h (mm) within radius w, with an edge ramp of width e
// (slope h/e ≤ 1 keeps the lower edge printable). d = distance along the surface from the disc centre.
const plateau = (d, w, e, h) => h * (1 - smoothstep(w - e, w, d));
const angDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= TAU; while (d < -Math.PI) d += TAU; return d; };

function buildOwl(b, rnd, ctx) {
  const { sf } = ctx;
  const s = Math.max(0.7, Math.min(1.6, sf));
  const R = rnd.range(24, 28) * s, Hb = R * rnd.range(2.3, 2.5);
  // egg body: flat bottom, ≤45° everywhere
  const r = (t) => R * Math.sqrt(Math.max(0, 1 - t * t)) * (1 - 0.08 * t);
  const z = (t) => ((t + 1) / 2) * Hb;
  let t0 = -0.99;
  for (let t = -0.99; t < 0; t += 0.002) { const dr = r(t + 0.001) - r(t - 0.001), dz = z(t + 0.001) - z(t - 0.001); if (dr / dz <= 0.9) { t0 = t; break; } }
  const zs0 = z(t0);
  const P = [{ r: 0, z: 0 }];
  const zsP = [], rsP = [];
  for (let i = 0; i <= 70; i++) { const t = t0 + (0.985 - t0) * (i / 70); P.push({ r: r(t), z: z(t) - zs0 }); zsP.push(z(t) - zs0); rsP.push(r(t)); }
  const Hegg = z(1) - zs0;
  P.push({ r: 0, z: Hegg });
  for (const q of P) if (q.z > 0.78 * Hegg) q.lift = true;
  const Rf = pchip(zsP, rsP);
  const eggR = (zz) => Math.max(0.5, Rf(clamp(zz, zsP[0], zsP[zsP.length - 1])));
  // Face and wings are part of the body surface: raised discs for the eyes, a ridge for the beak.
  const zEye = 0.64 * Hegg, aEye = 0.46, eyeW = 7 * s, eyeE = 3.2 * s, eyeH = 2.6 * s;
  const pupW = 2.6 * s, pupE = 1.6 * s, pupH = 1.3 * s;
  const zBeak = 0.52 * Hegg;
  const sec = (th, zz) => {
    const Rl = eggR(zz);
    let bump = 0;
    for (const sgn of [-1, 1]) {
      const d = Math.hypot(Rl * angDiff(th, sgn * aEye), zz - zEye);
      bump += plateau(d, eyeW, eyeE, eyeH) + plateau(d, pupW, pupE, pupH);
    }
    // beak: narrow vertical ridge, long ramp underneath
    const dth = Math.abs(Rl * angDiff(th, 0));
    const zw = smoothstep(zBeak - 7 * s, zBeak - 1.5 * s, zz) * (1 - smoothstep(zBeak + 1.5 * s, zBeak + 4 * s, zz));
    bump += 3.2 * s * Math.exp(-((dth / (2.4 * s)) ** 2)) * zw;
    // wing ridges on the sides
    const wing = Math.abs(Math.sin(th)) > 0.45 ? Math.sin(th) ** 2 : 0;
    const band = smoothstep(0.18 * Hegg, 0.3 * Hegg, zz) * (1 - smoothstep(0.58 * Hegg, 0.7 * Hegg, zz));
    bump += 1.3 * s * wing * band;
    return 1 + bump / Rl;
  };
  // ear tufts: the top rings rise at ±90°
  const lift = (th, p) => {
    const g = Math.exp(-((angDiff(th, Math.PI / 2) / 0.32) ** 2)) + Math.exp(-((angDiff(th, -Math.PI / 2) / 0.32) ** 2));
    const rr = p.r / R;
    const radial = Math.sin(Math.PI * Math.min(1, rr / 0.75)) ** 2;
    return 7 * s * g * radial;
  };
  lathe(b, P, { segments: 176, section: sec, lift });
  // feet: two rounded pads at the front
  for (const sgn of [-1, 1]) {
    lathe(b, [{ r: 0, z: 0 }, { r: 4.2 * s, inset: 0.6, z: 0 }, { r: 4.6 * s, z: 1.0 }, { r: 4.6 * s, z: 3 * s }, ...filletRings(4.6 * s, 5.5 * s, 2.5 * s, 4), { r: 0, z: 5.5 * s }],
      { segments: 48, section: sections.superellipse(1.3, 1, 3), transform: xf.translate(eggR(0) - 1.5 * s, sgn * 9 * s, 0) });
  }
  return { features: [['big round eyes', 'عينان كبيرتان مستديرتان'], ['soft wing ridges', 'أجنحة بارزة بنعومة'], ['blunt ear tufts', 'خصلات أذن مستديرة']] };
}

function buildCat(b, rnd, ctx) {
  const { sf } = ctx;
  const s = Math.max(0.7, Math.min(1.6, sf));
  const chub = rnd.range(0.94, 1.08);   // body roundness
  const neck = rnd.range(0.92, 1.06);   // neck slimness
  const zs = [0, 6, 20, 32, 40, 46, 52, 60, 64];
  const rs = [18, 19 * chub, 17.5 * chub, 13 * chub, 10.2 * neck, 13.6, 14.2, 11, 6].map((v) => v * s);
  const Rc = pchip(zs.map((v) => v * s), rs);
  const Ht = 64 * s;
  const P = [{ r: 0, z: 0 }, { r: Rc(0), inset: 0.8, z: 0 }, { r: Rc(0), z: 1 }];
  for (let i = 1; i <= 70; i++) { const zz = 1 + (Ht - 1 - 5 * s) * (i / 70); P.push({ r: Rc(zz), z: zz }); }
  for (let k = 1; k <= 6; k++) { const a = (Math.PI / 2) * (k / 6); P.push({ r: Rc(Ht - 5 * s) * Math.cos(a), z: Ht - 5 * s + 5 * s * Math.sin(a), lift: true }); }
  P.push({ r: 0, z: Ht, lift: true });
  const Rl = (zz) => Math.max(0.5, Rc(clamp(zz, 0, Ht - 5 * s)));
  const zm = 47 * s, ze = 53 * s;
  const sec = (th, zz) => {
    const R0 = Rl(zz);
    let bump = 0;
    // muzzle, nose and eyes on the front (+x)
    const dm = Math.hypot(R0 * angDiff(th, 0), (zz - zm) * 1.15);
    bump += plateau(dm, 6.2 * s, 4.2 * s, 3.6 * s);
    const dn = Math.hypot(R0 * angDiff(th, 0), zz - (zm + 2.2 * s));
    bump += plateau(dn, 1.9 * s, 1.6 * s, 1.2 * s);
    for (const sgn of [-1, 1]) {
      const d = Math.hypot(R0 * angDiff(th, sgn * 0.4), zz - ze);
      bump += plateau(d, 3.0 * s, 2.4 * s, 1.7 * s);
    }
    return 1 + bump / R0;
  };
  // ears: the crown rises at ±80°
  const Rtop = Rc(Ht - 5 * s);
  const lift = (th, p) => {
    const g = Math.exp(-((angDiff(th, 1.4) / 0.3) ** 2)) + Math.exp(-((angDiff(th, -1.4) / 0.3) ** 2));
    const rr = p.r / Rtop;
    const radial = Math.sin(Math.PI * Math.min(1, rr)) ** 2;
    return 9 * s * g * radial;
  };
  lathe(b, P, { segments: 160, section: sec, lift });
  // front paws
  for (const sgn of [-1, 1]) {
    lathe(b, [{ r: 0, z: 0 }, { r: 4.4 * s, inset: 0.6, z: 0 }, { r: 4.8 * s, z: 1.0 }, { r: 4.8 * s, z: 4 * s }, ...filletRings(4.8 * s, 7 * s, 3 * s, 4), { r: 0, z: 7 * s }],
      { segments: 48, section: sections.superellipse(1.25, 1, 3), transform: xf.translate(Rc(0) - 1.5 * s, sgn * 8 * s, 0) });
  }
  // tail: curls around the base, with a keel so it prints flat; it starts well inside the body
  const rt = 4.4 * s;
  const path = [];
  const r0 = Rc(5 * s) - 0.5;
  const curl = rnd.range(1.7, 2.2), side = rnd.pick([-1, 1]);
  for (let i = 0; i <= 26; i++) {
    const t = i / 26;
    const a = Math.PI + side * t * curl;
    const rr = r0 + rt * 0.9 + 4 * s * Math.sin(Math.PI * t);
    path.push([rr * Math.cos(a), rr * Math.sin(a), rt / Math.cos((50 * Math.PI) / 180) + 3 * s * t * t]);
  }
  path.unshift([r0 * 0.5 * Math.cos(Math.PI - 0.1), r0 * 0.5 * Math.sin(Math.PI - 0.1), path[0][2]]);
  tube(b, path, (t, i) => (i === 0 ? 0.5 : rt * (1 - 0.35 * t)), { keel: true, seg: 20 });
  return { features: [['a curled tail', 'ذيل ملتف'], ['rounded ears and paws', 'أذنان وكفّان مستديران']] };
}

// ---------------------------------------------------------------------------------------------
// Category resolution

const OBJECT_ORDER = [
  ['keychain', 'keychain'], ['headphoneStand', 'headphone_stand'], ['phoneStand', 'phone_stand'], ['cable', 'cable'], ['hook', 'hook'],
  ['bookend', 'bookend'], ['dice', 'dice'], ['penHolder', 'pen_holder'], ['trophy', 'trophy'], ['lamp', 'lamp'], ['planter', 'planter'],
  ['trinket', 'organizer'], ['organizer', 'organizer'], ['vase', 'vase'], ['ornament', 'ornament'], ['rocket', 'rocket'],
];

function resolveCategory(P, rnd) {
  let object = null;
  for (const [key, cat] of OBJECT_ORDER) if (P.has(key)) { object = cat; break; }
  if (object === 'keychain') return { cat: 'keychain' };
  const pieces = [];
  const chessCtx = P.has('chess');
  if (P.has('king') && (chessCtx || !object)) pieces.push('king');
  if (P.has('queen') && (chessCtx || !object)) pieces.push('queen');
  if (P.has('bishop') && (chessCtx || /bishop/.test(P.text))) pieces.push('bishop');
  if (P.has('knight') && (chessCtx || !object)) pieces.push('knight');
  if (P.has('rook') || (chessCtx && (P.has('castle') || P.has('tower')))) pieces.push('rook');
  if (P.has('pawn') || (chessCtx && P.has('pawnAr'))) pieces.push('pawn');
  if (chessCtx || P.has('pawn') || P.has('rook') || (!object && pieces.length)) {
    let piece;
    if (P.has('set') || pieces.length > 1) piece = 'set';
    else if (pieces.length === 1) piece = pieces[0];
    else if (P.has('piece')) piece = rnd.pick(['pawn', 'rook', 'knight', 'bishop', 'queen', 'king']);
    else piece = 'set';
    return { cat: 'chess', piece };
  }
  if (P.has('owl')) return { cat: 'owl' };
  if (P.has('cat')) return { cat: 'cat' };
  if (object) return { cat: object };
  if (P.has('castle')) return { cat: 'castle' };
  if (P.has('tower')) return { cat: 'tower' };
  if (P.has('egg') || (P.has('dragon') && !P.has('sculpture'))) return { cat: 'dragon_egg' };
  if (P.has('figurine')) return { cat: rnd.pick(['owl', 'cat']) };
  return { cat: 'sculpture' };
}

const CATEGORY_OF = { tower: 'castle', dragon_egg: 'sculpture', owl: 'sculpture', cat: 'sculpture' };

const BUILDERS = {
  vase: buildVase, planter: buildPlanter, pen_holder: buildPenHolder, lamp: buildLamp, trophy: buildTrophy, rocket: buildRocket,
  castle: buildCastle, tower: buildTower, ornament: buildOrnament, dragon_egg: buildDragonEgg, sculpture: buildSculpture,
  keychain: buildKeychain, phone_stand: buildPhoneStand, organizer: buildOrganizer, bookend: buildBookend,
  headphone_stand: buildHeadphoneStand, hook: buildHook, cable: buildCable, dice: buildDice, owl: buildOwl, cat: buildCat,
};

const STYLE_ORDER = ['spiral', 'twisted', 'faceted', 'star', 'flower', 'wavy', 'gear', 'hexagon', 'castle', 'tower', 'dragon'];
// Which styles can show up in the title for each kind of object.
const TITLE_STYLES = {
  chess: ['spiral', 'twisted'],
  keychain: [], phone_stand: [], organizer: [], rocket: [], trophy: [], bookend: [], headphone_stand: [], hook: [], cable: [], dice: [], owl: [], cat: [],
  castle: ['faceted', 'hexagon'], tower: ['spiral', 'twisted', 'faceted', 'hexagon'], dragon_egg: [], sculpture: ['faceted'],
  pen_holder: ['spiral', 'twisted', 'faceted', 'star', 'flower', 'wavy', 'gear', 'hexagon', 'castle'],
};

function runBuild(prompt, seed, sfOverride) {
  const P = parsePrompt(prompt);
  const rnd = makeRng(hashStr(`${P.text}#${seed}`));
  const { cat, piece } = resolveCategory(P, rnd);
  const sizes = ['small', 'large', 'tall', 'short', 'wide'].filter((s) => P.has(s));
  let sf = P.has('small') ? 0.75 : P.has('large') ? 1.3 : 1;
  if (sfOverride) sf = sfOverride;
  const hf = P.has('tall') ? 1.3 : P.has('short') ? 0.75 : 1;
  const wf = P.has('wide') ? 1.25 : 1;
  let styles = STYLE_ORDER.filter((s) => P.has(s));
  if (styles.includes('spiral')) styles = styles.filter((s) => s !== 'twisted');
  const ctx = { P, sf, hf, wf, styles };
  const b = new Builder();
  let result;
  if (cat === 'chess') result = buildChess(b, rnd, ctx, piece);
  else result = BUILDERS[cat](b, rnd, ctx) || {};
  let mesh = b.toMesh();
  if (result.scaleAfter && result.scaleAfter !== 1) mesh = scaleMesh(mesh, result.scaleAfter);
  // Keep everything within the printer limit (250 mm, with margin).
  const largest = Math.max(...computeBBox(mesh).size);
  if (largest > 245) mesh = scaleMesh(mesh, 245 / largest);
  mesh = placeOnBed(mesh);
  return { P, cat, piece, mesh, result, ctx, sizes };
}

/**
 * Generate a printable demo model from a text prompt.
 * @param {string} prompt English or Arabic description
 * @param {{seed?: number}} options a different seed gives a different variation
 */
export function generateFromPrompt(prompt, { seed = 1 } = {}) {
  let run = runBuild(prompt, seed);
  if (run.P.targetMm) {
    const target = Math.min(245, run.P.targetMm);
    const bb = computeBBox(run.mesh);
    const wantsHeight = /tall|high|height|طول|ارتفاع|طويل/.test(run.P.text);
    const measured = wantsHeight ? bb.size[2] : Math.max(...bb.size);
    if (measured > 0) {
      const sf2 = Math.min(3, Math.max(0.3, run.ctx.sf * (target / measured)));
      run = runBuild(prompt, seed, sf2);
      const bb2 = computeBBox(run.mesh);
      const m2 = wantsHeight ? bb2.size[2] : Math.max(...bb2.size);
      const k = target / m2;
      if (Math.abs(k - 1) > 0.02 && Math.max(...bb2.size) * k <= 245) run.mesh = placeOnBed(scaleMesh(run.mesh, k));
    }
  }
  return { mesh: run.mesh, info: describe(prompt, run) };
}

function describe(prompt, run) {
  const { P, cat, piece, result, ctx, mesh } = run;
  const bb = computeBBox(mesh);
  const [W, D, H] = bb.size.map((v) => Math.round(v));
  let nounKey = cat;
  if (cat === 'chess') nounKey = piece === 'set' ? 'chess_set' : piece;
  if (cat === 'organizer' && result.lid) nounKey = 'box_lid';
  const allowed = TITLE_STYLES[cat === 'chess' ? 'chess' : cat];
  const styles = allowed ? ctx.styles.filter((s) => allowed.includes(s)) : ctx.styles;
  const extra = result.extra || {};
  const titleStyles = extra.dragonHandle ? styles.filter((s) => s !== 'dragon') : styles;
  const sizeWord = run.sizes.filter((s) => s !== 'small' || !['keychain'].includes(cat));
  const title = composeTitle(nounKey, sizeWord.slice(0, 1), titleStyles, extra);
  const feats = featureList(styles.filter((s) => !(extra.castleShape && s === 'castle')), { dragonHandle: extra.dragonHandle, features: result.features });

  const noun = NOUNS[nounKey];
  const dimsEn = `${W} × ${D} × ${H} mm`;
  let en = `${aOrAn(noun.en)} ${noun.en}, about ${H} mm tall (${dimsEn})`;
  let ar = `${noun.ar} بارتفاع ${H} مم تقريبًا (${W} × ${D} × ${H} مم)`;
  if (feats.en.length) { en += ` with ${joinList(feats.en, 'en')}`; ar += ` مع ${joinList(feats.ar, 'ar')}`; }
  en += '.'; ar += '.';
  const tail = TAILS[nounKey] || TAILS[cat];
  if (tail) {
    const t = typeof tail === 'function' ? tail(result, prompt) : tail;
    en += ' ' + t[0]; ar += ' ' + t[1];
  }
  en += ' Thick rounded walls for everyday knocks; printed to order in the colour you choose.';
  ar += ' جدران سميكة مستديرة تتحمل الاستخدام اليومي، وتُطبع حسب الطلب باللون الذي تختاره.';
  const keywords = [...P.found].filter((k) => k !== 'pawnAr').map((k) => (k === 'phoneStand' ? 'phone_stand' : k === 'penHolder' ? 'pen_holder' : k === 'headphoneStand' ? 'headphone_stand' : k));
  return {
    category: CATEGORY_OF[cat] || cat,
    titleEn: title.en,
    titleAr: title.ar,
    descriptionEn: en,
    descriptionAr: ar,
    keywords,
  };
}

function aOrAn(word) { return /^[aeiou]/i.test(word) ? 'An' : 'A'; }

const TAILS = {
  vase: ['For dried flowers, pampas grass or brushes.', 'للزهور المجففة أو عشب البامباس أو الفرش.'],
  planter: ['Fits a small houseplant or succulent; use a liner for soil.', 'يناسب نبتة منزلية صغيرة أو صبارًا، مع بطانة داخلية للتربة.'],
  pen_holder: ['Fits pens, scissors and rulers.', 'يتسع للأقلام والمقص والمسطرة.'],
  lamp: ['Use LED bulbs only.', 'استخدم مصابيح LED فقط.'],
  trophy: ['A solid stepped base keeps it steady on a shelf.', 'قاعدة متدرجة متينة تبقيه ثابتًا على الرف.'],
  keychain: ['Thick and rounded, made for pockets and key rings.', 'سميكة ومستديرة، مصممة للجيب وحلقات المفاتيح.'],
  phone_stand: ['Holds phones and small tablets at a comfortable viewing angle.', 'يحمل الجوال والأجهزة اللوحية الصغيرة بزاوية مشاهدة مريحة.'],
  headphone_stand: ['Keeps over-ear headphones off the desk.', 'يحفظ سماعات الرأس بعيدًا عن سطح المكتب.'],
  hook: ['Print it flat, then mount it to a wall or the side of a desk.', 'يُطبع مستويًا ثم يُثبت على الجدار أو جانب المكتب.'],
  cable: ['Press cables between the posts to keep them tidy.', 'ضع الكابلات بين الأعمدة لتبقى مرتبة.'],
  bookend: ['Holds a row of books upright; pair it with a second one.', 'يسند صف الكتب، ويمكن طلب اثنين كزوج.'],
  dice: ['A chunky tabletop die; the pips are recessed, not painted.', 'حجر نرد ضخم لألعاب الطاولة، نقاطه غائرة وليست مطبوعة.'],
  owl: ['A shelf and desk companion with a flat, stable base.', 'رفيق للرف والمكتب بقاعدة مسطحة ثابتة.'],
  cat: ['A shelf and desk companion with a flat, stable base.', 'رفيق للرف والمكتب بقاعدة مسطحة ثابتة.'],
  organizer: ['Keeps pens, cables and small parts in order.', 'ينظم الأقلام والكابلات والقطع الصغيرة.'],
  box_lid: ['The lid has a locating lip so it sits snugly.', 'للغطاء حافة داخلية تجعله يثبت بإحكام.'],
  ornament: ['Hang it with a ribbon through the top loop.', 'علّقها بشريط عبر الحلقة العلوية.'],
  rocket: ['Stands upright on its fins.', 'يقف منتصبًا على زعانفه.'],
  castle: ['A display piece for shelves, desks and tabletop games.', 'قطعة عرض للرفوف والمكاتب وألعاب الطاولة.'],
  tower: ['A display piece for shelves, desks and tabletop games.', 'قطعة عرض للرفوف والمكاتب وألعاب الطاولة.'],
  dragon_egg: ['A dramatic shelf piece for fantasy fans.', 'قطعة عرض مميزة لمحبي الخيال.'],
  sculpture: (r, prompt) => [`An organic one-off form inspired by “${String(prompt).trim().slice(0, 80)}”.`, `شكل عضوي فريد مستوحى من «${String(prompt).trim().slice(0, 80)}».`],
  chess_set: ['One of each piece, sized for a board with 50 mm squares.', 'قطعة واحدة من كل نوع، بمقاس يناسب رقعة بمربعات 50 مم.'],
  pawn: ['Sized for a board with 50 mm squares.', 'بمقاس يناسب رقعة بمربعات 50 مم.'],
  rook: ['Sized for a board with 50 mm squares.', 'بمقاس يناسب رقعة بمربعات 50 مم.'],
  knight: ['A sculpted horse head, sized for a board with 50 mm squares.', 'رأس حصان منحوت، بمقاس يناسب رقعة بمربعات 50 مم.'],
  bishop: ['Sized for a board with 50 mm squares.', 'بمقاس يناسب رقعة بمربعات 50 مم.'],
  queen: ['Sized for a board with 50 mm squares.', 'بمقاس يناسب رقعة بمربعات 50 مم.'],
  king: ['Sized for a board with 50 mm squares.', 'بمقاس يناسب رقعة بمربعات 50 مم.'],
};

export { box, sweepRings, circleSection, icosphere, prism, vadd };
