// Prompt2Print pricing engine. Pure functions, no database access.
// All money is handled in integer cents to avoid floating-point rounding errors.
//
//   1. Filament = model weight (g) × price per gram of the material
//      weight comes from volume, infill %, wall thickness and material density
//   2. Tax      = tax rate (by country/region) × filament cost
//   3. Shipping = by package weight, size and destination zone
//   4. Subtotal = filament + tax + shipping
//   5. Service fee = first matching tier, by default 15% up to $100 and 5% above $100
//   6. Total    = subtotal + service fee

export const DEFAULT_FEE_TIERS = [
  { maxCents: 10000, percent: 15 }, // subtotal ≤ $100 → 15%
  { maxCents: null, percent: 5 },   // subtotal > $100 → 5%
];

// Multiply cents by a percentage and round half up, using integer basis points.
export function percentOf(cents, percent) {
  const bps = Math.round(percent * 100);       // 15% → 1500
  const product = cents * bps;                 // exact integer
  return Math.floor((product + 5000) / 10000); // round half up
}

/**
 * Estimated printed weight in grams.
 * The outer shell (walls, top and bottom skins) is solid; the inside is filled at `infillPercent`.
 * shell volume ≈ surface area × wall thickness (capped at the model volume for thin parts).
 */
export function estimateWeightGrams({ volumeMm3, areaMm2, scale = 1, infillPercent, wallMm = 1.2, density }) {
  const v = volumeMm3 * scale ** 3;
  const a = areaMm2 * scale ** 2;
  const shell = Math.min(v, a * wallMm);
  const inside = Math.max(0, v - shell);
  const printedMm3 = shell + inside * (Math.min(100, Math.max(0, infillPercent)) / 100);
  return (printedMm3 / 1000) * density; // mm³ → cm³ → g
}

export function filamentCostCents(weightGrams, pricePerGram) {
  return Math.round(weightGrams * pricePerGram * 100);
}

export function taxCents(filamentCents, ratePercent) {
  return percentOf(filamentCents, ratePercent || 0);
}

/**
 * Shipping by package weight, size and zone.
 * billable kg = max(actual kg, volumetric kg) rounded up to the next 0.5 kg,
 * volumetric kg = L×W×H (cm³) / divisor.
 * cost = base + per-kg × billable kg
 */
export function shippingCents(pkg, zone) {
  if (!zone) return null;
  const [l, w, h] = pkg.dimsMm.map((v) => v / 10);
  const actualKg = pkg.weightGrams / 1000;
  const volumetricKg = (l * w * h) / (zone.volumetric_divisor || 5000);
  const billableKg = Math.max(0.5, Math.ceil(Math.max(actualKg, volumetricKg) * 2) / 2);
  return {
    cents: zone.base_cents + Math.round(zone.per_kg_cents * billableKg),
    billableKg,
    actualKg,
    volumetricKg,
  };
}

/**
 * Package for one or more printed items: each item is boxed with padding, then the boxes are
 * combined. Packaging adds 60 g plus 5% of the contents.
 * items: [{ sizeMm: [x,y,z], weightGrams, quantity }]
 */
export function packageFor(items, paddingMm = 20) {
  let weight = 0;
  let volume = 0;
  let longest = 0;
  for (const it of items) {
    const q = it.quantity || 1;
    const box = it.sizeMm.map((v) => v + paddingMm);
    weight += it.weightGrams * q;
    volume += box[0] * box[1] * box[2] * q;
    longest = Math.max(longest, ...box);
  }
  // Pack the combined volume into a box at least as long as the longest item.
  const side = Math.sqrt(volume / Math.max(longest, 1));
  const dims = items.length === 1 && (items[0].quantity || 1) === 1
    ? items[0].sizeMm.map((v) => v + paddingMm)
    : [longest, side, side];
  return { weightGrams: weight + 60 + weight * 0.05, dimsMm: dims };
}

export function serviceFee(subtotalCents, tiers = DEFAULT_FEE_TIERS) {
  const sorted = [...tiers].sort((a, b) => (a.maxCents ?? Infinity) - (b.maxCents ?? Infinity));
  const tier = sorted.find((t) => t.maxCents === null || t.maxCents === undefined || subtotalCents <= t.maxCents) || sorted[sorted.length - 1];
  return { percent: tier.percent, cents: percentOf(subtotalCents, tier.percent), tier };
}

/** Steps 4–6: put the parts together. */
export function priceBreakdown({ filamentCents, taxCents: tax, shippingCents: shipping, feeTiers = DEFAULT_FEE_TIERS }) {
  const subtotal = filamentCents + tax + shipping;
  const fee = serviceFee(subtotal, feeTiers);
  return {
    filamentCents,
    taxCents: tax,
    shippingCents: shipping,
    subtotalCents: subtotal,
    feePercent: fee.percent,
    feeCents: fee.cents,
    totalCents: subtotal + fee.cents,
  };
}

// Look up the tax rate: exact country+region, then the country, then the '*' fallback.
export function findTaxRate(rates, country, region) {
  const c = (country || '').toUpperCase();
  const r = (region || '').toUpperCase();
  return (
    rates.find((t) => t.country === c && t.region !== '*' && t.region.toUpperCase() === r) ||
    rates.find((t) => t.country === c && t.region === '*') ||
    rates.find((t) => t.country === '*') ||
    { rate: 0, label: 'No tax' }
  );
}

export function findShippingZone(zones, country) {
  const c = (country || '').toUpperCase();
  const active = zones.filter((z) => z.active);
  return active.find((z) => z.countries.includes(c)) || active.find((z) => z.countries.includes('*')) || null;
}
