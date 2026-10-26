// Pricing engine, client side. The same maths as the server (the `checkout` Edge Function
// recomputes every order), so prices shown in the app are instant and identical to what is charged.
// All money is in integer halalas (SAR cents).

export const DEFAULT_FEE_TIERS = [{ maxCents: 37500, percent: 15 }, { maxCents: null, percent: 5 }];

export function percentOf(cents, percent) {
  const bps = Math.round(percent * 100);
  return Math.floor((cents * bps + 5000) / 10000);
}

export function estimateWeightGrams({ volumeMm3, areaMm2, scale = 1, infillPercent, wallMm = 2.1, density }) {
  const v = volumeMm3 * scale ** 3;
  const a = areaMm2 * scale ** 2;
  const shell = Math.min(v, a * wallMm);
  const inside = Math.max(0, v - shell);
  const printedMm3 = shell + inside * (Math.min(100, Math.max(0, infillPercent)) / 100);
  return (printedMm3 / 1000) * density;
}
export const filamentCostCents = (weightGrams, pricePerGram) => Math.round(weightGrams * pricePerGram * 100);
export const taxCents = (filamentCents, ratePercent) => percentOf(filamentCents, ratePercent || 0);

export function shippingCents(pkg, zone) {
  if (!zone) return null;
  const [l, w, h] = pkg.dimsMm.map((v) => v / 10);
  const actualKg = pkg.weightGrams / 1000;
  const volumetricKg = (l * w * h) / (zone.volumetric_divisor || 5000);
  const billableKg = Math.max(0.5, Math.ceil(Math.max(actualKg, volumetricKg) * 2) / 2);
  return { cents: zone.base_cents + Math.round(zone.per_kg_cents * billableKg), billableKg, actualKg, volumetricKg };
}

export function packageFor(items, paddingMm = 20) {
  let weight = 0, volume = 0, longest = 0;
  for (const it of items) {
    const q = it.quantity || 1;
    const box = it.sizeMm.map((v) => v + paddingMm);
    weight += it.weightGrams * q;
    volume += box[0] * box[1] * box[2] * q;
    longest = Math.max(longest, ...box);
  }
  const side = Math.sqrt(volume / Math.max(longest, 1));
  const dims = items.length === 1 && (items[0].quantity || 1) === 1 ? items[0].sizeMm.map((v) => v + paddingMm) : [longest, side, side];
  return { weightGrams: weight + 60 + weight * 0.05, dimsMm: dims };
}

export function serviceFee(subtotalCents, tiers = DEFAULT_FEE_TIERS) {
  const sorted = [...tiers].sort((a, b) => (a.maxCents ?? Infinity) - (b.maxCents ?? Infinity));
  const tier = sorted.find((t) => t.maxCents === null || t.maxCents === undefined || subtotalCents <= t.maxCents) || sorted[sorted.length - 1];
  return { percent: tier.percent, cents: percentOf(subtotalCents, tier.percent), tier };
}

export function priceBreakdown({ filamentCents, taxCents: tax, shippingCents: shipping, feeTiers = DEFAULT_FEE_TIERS }) {
  const subtotal = filamentCents + tax + shipping;
  const fee = serviceFee(subtotal, feeTiers);
  return { filamentCents, taxCents: tax, shippingCents: shipping, subtotalCents: subtotal, feePercent: fee.percent, feeCents: fee.cents, totalCents: subtotal + fee.cents };
}

export function findTaxRate(rates, country, region) {
  const c = (country || '').toUpperCase(), r = (region || '').toUpperCase();
  return rates.find((t) => t.country === c && t.region !== '*' && t.region.toUpperCase() === r)
    || rates.find((t) => t.country === c && t.region === '*')
    || rates.find((t) => t.country === '*')
    || { rate: 0, label: 'No tax' };
}

export function findShippingZone(zones, country) {
  const c = (country || '').toUpperCase();
  const active = zones.filter((z) => z.active !== false);
  return active.find((z) => z.countries.includes(c)) || active.find((z) => z.countries.includes('*')) || null;
}

// ---------- printability (from the stored model analysis; no geometry needed) ----------
function thinShare(profile, scale, minMm) {
  const q = profile?.quantiles;
  if (!q?.length) return 0;
  const limit = minMm / scale;
  if (q[0] >= limit) return 0;
  if (q[q.length - 1] < limit) return 1;
  for (let i = 1; i < q.length; i++) {
    if (q[i] >= limit) {
      const f = q[i] === q[i - 1] ? 0 : (limit - q[i - 1]) / (q[i] - q[i - 1]);
      return ((i - 1) + f) / (q.length - 1);
    }
  }
  return 1;
}
function thicknessAt(profile, share) {
  const q = profile?.quantiles;
  if (!q?.length) return Infinity;
  const pos = Math.min(1, Math.max(0, share)) * (q.length - 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return q[lo] + (q[hi] - q[lo]) * (pos - lo);
}
function minScaleForWalls(analysis, minWallMm = 2, share = 0.03) {
  if (!analysis.thickness) return 0;
  const t = thicknessAt(analysis.thickness, share);
  return t > 0 && Number.isFinite(t) ? (minWallMm * 0.95) / t : 0;
}
function fitsBed(size, bed, marginMm = 4) {
  const bx = bed.x - marginMm, by = bed.y - marginMm, bz = bed.z - marginMm;
  const [x, y, z] = size;
  if (z > bz) return false;
  return (x <= bx && y <= by) || (x <= by && y <= bx);
}
function maxScaleForBed(size, bed, marginMm = 4) {
  const bx = bed.x - marginMm, by = bed.y - marginMm, bz = bed.z - marginMm;
  const [x, y, z] = size.map((v) => Math.max(v, 1e-6));
  return Math.min(Math.max(Math.min(bx / x, by / y), Math.min(by / x, bx / y)), bz / z);
}

export function checkPrintability(analysis, scale, opts = {}) {
  const maxModelMm = opts.maxModelMm ?? 250, minWallMm = opts.minWallMm ?? 2, minFeatureMm = 10, supportAreaLimit = 25;
  const bed = opts.bed || { x: maxModelMm + 6, y: maxModelMm + 6, z: maxModelMm + 6 };
  const bboxSize = analysis.bbox?.size || analysis.sizeMm || [0, 0, 0];
  const size = bboxSize.map((v) => v * scale);
  const withinLimit = Math.max(...size) <= maxModelMm + 1e-6;
  const fits = withinLimit && fitsBed(size, bed);
  const maxScale = Math.min(maxModelMm / Math.max(...bboxSize, 1e-6), maxScaleForBed(bboxSize, bed));
  const overhang = (analysis.overhangAreaMm2 || 0) * scale * scale;
  const checks = [];
  const watertight = analysis.watertight !== false;
  checks.push({ id: 'watertight', status: watertight ? 'pass' : 'fail', detail: watertight ? 'Closed, watertight mesh' : 'The model has holes' });
  checks.push({ id: 'bed', status: fits ? 'pass' : 'fail', detail: fits ? `Fits our printer (max ${maxModelMm} mm)` : `Too large: the largest side can be at most ${maxModelMm} mm (${Math.round(maxScale * 100)}% of this design).`, maxScale, maxModelMm });
  if (analysis.thickness) {
    const thin = thinShare(analysis.thickness, scale, minWallMm * 0.95);
    const minScale = minScaleForWalls(analysis, minWallMm);
    const status = thin > 0.15 ? 'fail' : thin > 0.03 ? 'warn' : 'pass';
    checks.push({
      id: 'walls', status, thinPercent: Math.round(thin * 1000) / 10, minScale, minLargestMm: Math.ceil(minScale * Math.max(...bboxSize)),
      detail: status === 'pass' ? `Walls are at least ${minWallMm} mm`
        : `${Math.round(thin * 100)}% of the surface is thinner than ${minWallMm} mm${status === 'fail' ? ` — make it at least ${Math.ceil(minScale * Math.max(...bboxSize))} mm` : ' and may break if dropped'}`,
    });
  }
  const sorted = [...size].sort((a, b) => a - b);
  const slender = sorted[0] > 0 && sorted[2] / sorted[0] > 8;
  checks.push({ id: 'shape', status: slender ? 'warn' : 'pass', detail: slender ? 'Long, thin shape: it may snap if dropped' : 'Compact, sturdy shape' });
  checks.push({ id: 'min_size', status: Math.max(...size) >= minFeatureMm ? 'pass' : 'fail', detail: Math.max(...size) >= minFeatureMm ? 'Large enough to print' : `Smaller than ${minFeatureMm} mm` });
  const needsSupports = overhang > supportAreaLimit;
  checks.push({ id: 'supports', status: needsSupports ? 'warn' : 'pass', detail: needsSupports ? `About ${Math.round(overhang)} mm² of overhangs: printed with supports` : 'No supports needed', needsSupports });
  const ok = checks.every((c) => c.status !== 'fail');
  const fragile = checks.some((c) => (c.id === 'walls' || c.id === 'shape') && c.status === 'warn');
  return { ok, needsSupports, fragile, sizeMm: size, checks, maxScale, minScale: analysis.thickness ? minScaleForWalls(analysis, minWallMm) : 0 };
}

export class PriceError extends Error {
  constructor(message, code) { super(message); this.code = code; this.status = 400; }
}

// ctx: { materials: {code: material row}, taxRates, zones, feeTiers, wallMm, infillRange, maxModelMm, minWallMm, currencies, countryCurrency, fallbackCurrency }
export function priceLine(ctx, line) {
  const mat = ctx.materials[line.material];
  if (!mat || mat.active === false) throw new PriceError(`Material ${line.material} is not available.`, 'invalid_material');
  if (line.allowedMaterials && !line.allowedMaterials.includes(line.material)) throw new PriceError(`${line.material} is not offered for this item.`, 'invalid_material');
  const color = (mat.colors || []).find((c) => c.code === line.color) || null;
  if (!color) throw new PriceError('Pick one of the listed colours.', 'invalid_color');
  if (color.in_stock === false) throw new PriceError('That colour is out of stock right now. Pick another colour.', 'color_out_of_stock');
  const scale = Number(line.scale);
  if (!(scale > 0) || scale > 20) throw new PriceError('Size is out of range.', 'invalid_scale');
  if (line.minScale && scale < line.minScale - 1e-9) throw new PriceError('That size is smaller than this item allows.', 'invalid_scale');
  if (line.maxScale && scale > line.maxScale + 1e-9) throw new PriceError('That size is larger than this item allows.', 'invalid_scale');
  const infill = Math.round(Number(line.infill));
  const [minInfill, maxInfill] = ctx.infillRange || [30, 40];
  if (!(infill >= minInfill && infill <= maxInfill)) throw new PriceError(`Infill must be between ${minInfill}% and ${maxInfill}%.`, 'invalid_infill');
  const quantity = Math.round(Number(line.quantity || 1));
  if (!(quantity >= 1 && quantity <= 50)) throw new PriceError('Quantity must be between 1 and 50.', 'invalid_quantity');
  const a = line.analysis;
  const unitWeight = estimateWeightGrams({ volumeMm3: a.volumeMm3, areaMm2: a.areaMm2, scale, infillPercent: infill, wallMm: ctx.wallMm, density: Number(mat.density) });
  const unitFilament = filamentCostCents(unitWeight, Number(mat.price_per_gram));
  const printability = checkPrintability(a, scale, { maxModelMm: ctx.maxModelMm, minWallMm: ctx.minWallMm });
  return {
    material: mat.code, materialName: { en: mat.name_en, ar: mat.name_ar }, color: color.code, colorName: { en: color.name_en, ar: color.name_ar }, colorHex: color.hex,
    scale, infill, quantity,
    sizeMm: printability.sizeMm.map((v) => Math.round(v * 10) / 10),
    unitWeightGrams: Math.round(unitWeight * 10) / 10, weightGrams: Math.round(unitWeight * quantity * 10) / 10,
    pricePerGram: Number(mat.price_per_gram), unitFilamentCents: unitFilament, filamentCents: unitFilament * quantity, printability,
  };
}

export function currencyFor(ctx, country) {
  const code = ctx.countryCurrency[String(country || '').toUpperCase()] || ctx.fallbackCurrency || 'USD';
  return ctx.currencies.find((c) => c.code === code) || ctx.currencies.find((c) => c.code === 'SAR') || { code: 'SAR', rate: 1, decimals: 2 };
}
export function convert(baseCents, currency) {
  const f = 10 ** (currency.decimals ?? 2);
  return Math.round((baseCents / 100) * (Number(currency.rate) || 1) * f) / f;
}

export function quoteLines(ctx, pricedLines, destination) {
  const country = (destination?.country || ctx.defaultCountry || 'SA').toUpperCase();
  const region = destination?.region || '';
  const filamentCents = pricedLines.reduce((s, l) => s + l.filamentCents, 0);
  const taxRate = findTaxRate(ctx.taxRates, country, region);
  const tax = taxCents(filamentCents, Number(taxRate.rate));
  const zone = findShippingZone(ctx.zones, country);
  const pkg = packageFor(pricedLines.map((l) => ({ sizeMm: l.sizeMm, weightGrams: l.unitWeightGrams, quantity: l.quantity })));
  const ship = zone ? shippingCents(pkg, zone) : null;
  const breakdown = priceBreakdown({ filamentCents, taxCents: tax, shippingCents: ship ? ship.cents : 0, feeTiers: ctx.feeTiers });
  const display = currencyFor(ctx, country);
  return {
    currency: 'SAR',
    display: { currency: display.code, rate: Number(display.rate), decimals: display.decimals, total: convert(breakdown.totalCents, display) },
    destination: { country, region },
    lines: pricedLines,
    taxRate: { rate: Number(taxRate.rate), label: taxRate.label || null },
    shipping: zone ? { zone: { id: zone.id, en: zone.name_en, ar: zone.name_ar }, billableKg: ship.billableKg, days: [zone.min_days, zone.max_days] } : null,
    shipsToDestination: Boolean(zone),
    breakdown,
    printable: pricedLines.every((l) => l.printability.ok),
  };
}

export function publicAnalysis(a) {
  if (!a || !a.bbox) return { sizeMm: [0, 0, 0], volumeCm3: 0, triangles: 0, watertight: false };
  return { sizeMm: a.bbox.size.map((v) => Math.round(v * 10) / 10), volumeCm3: Math.round(a.volumeMm3 / 100) / 10, triangles: a.triangles, watertight: a.watertight };
}
