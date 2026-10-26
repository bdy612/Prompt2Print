// Quotes for the cloud API: the same maths as the original pricing engine, with the shop's
// settings loaded from Postgres instead of SQLite. Money is integer halalas.
import * as engine from './pricing-engine.js';
import { checkPrintability } from './mesh/analyze.js';
import { HttpError } from './http.js';

export const BASE_CURRENCY = 'SAR';

/** Load materials, taxes, zones, printers, currencies and settings in one round of queries. */
export async function loadPricingContext(db) {
  const [materials, taxRates, zones, printers, types, settings, currencies, countryCurrency] = await Promise.all([
    db.from('materials').select('*').order('sort'),
    db.from('tax_rates').select('*'),
    db.from('shipping_zones').select('*').eq('active', true).order('sort'),
    db.from('printers').select('id,name,type_code,materials,nozzle_mm,active').eq('active', true),
    db.from('printer_types').select('code,bed,max_nozzle_c,max_bed_c'),
    db.from('settings').select('key,value'),
    db.from('currencies').select('*').order('sort'),
    db.from('country_currency').select('*'),
  ]);
  for (const r of [materials, taxRates, zones, printers, types, settings, currencies, countryCurrency]) if (r.error) throw new Error(r.error.message);
  const setting = (k, d) => { const row = settings.data.find((s) => s.key === k); return row ? row.value : d; };
  const bedOf = Object.fromEntries(types.data.map((t) => [t.code, t.bed]));
  const mats = {};
  for (const m of materials.data) mats[m.code] = { ...m, price_per_gram: Number(m.price_per_gram), density: Number(m.density) };
  let activePrinters = printers.data.map((p) => ({ id: p.id, name: p.name, active: true, bed: bedOf[p.type_code] || { x: 256, y: 256, z: 256 }, materials: p.materials || [] }));
  // Until a printer is switched on, price against the shop's standard printer so the catalog still works.
  if (!activePrinters.length) activePrinters = [{ id: 0, name: 'Bambu Lab P2S', active: true, bed: { x: 256, y: 256, z: 256 }, materials: Object.keys(mats) }];
  return {
    materials: mats,
    taxRates: taxRates.data.map((t) => ({ ...t, rate: Number(t.rate) })),
    zones: zones.data,
    printers: activePrinters,
    feeTiers: setting('fee_tiers', engine.DEFAULT_FEE_TIERS),
    wallMm: Number(setting('wall_thickness_mm', 2.1)),
    currency: BASE_CURRENCY,
    infillRange: setting('infill_range', [30, 40]),
    maxModelMm: Number(setting('max_model_mm', 250)),
    minWallMm: Number(setting('min_wall_mm', 2)),
    defaultCountry: setting('default_country', 'SA'),
    fallbackCurrency: setting('fallback_currency', 'USD'),
    currencies: currencies.data.map((c) => ({ ...c, rate: Number(c.rate) })),
    countryCurrency: Object.fromEntries(countryCurrency.data.map((r) => [r.country, r.currency])),
  };
}

export function currencyFor(ctx, country) {
  const code = ctx.countryCurrency[String(country || '').toUpperCase()] || ctx.fallbackCurrency;
  return ctx.currencies.find((c) => c.code === code) || ctx.currencies.find((c) => c.code === BASE_CURRENCY) || { code: 'SAR', rate: 1, decimals: 2 };
}

export function convert(baseCents, currency) {
  const amount = (baseCents / 100) * (currency.rate || 1);
  const f = 10 ** (currency.decimals ?? 2);
  return Math.round(amount * f) / f;
}

const bad = (message, code) => new HttpError(400, message, code);

/** Price one line before tax/shipping/fee. line: { analysis, material, color, scale, infill, quantity, allowedMaterials?, minScale?, maxScale? } */
export function priceLine(ctx, line) {
  const mat = ctx.materials[line.material];
  if (!mat || !mat.active) throw bad(`Material ${line.material} is not available.`, 'invalid_material');
  if (line.allowedMaterials && !line.allowedMaterials.includes(line.material)) throw bad(`${line.material} is not offered for this item.`, 'invalid_material');
  const color = (mat.colors || []).find((c) => c.code === line.color) || null;
  if (!color) throw bad('Pick one of the listed colours.', 'invalid_color');
  if (color.in_stock === false) throw bad('That colour is out of stock right now. Pick another colour.', 'color_out_of_stock');
  const scale = Number(line.scale);
  if (!(scale > 0) || scale > 20) throw bad('Size is out of range.', 'invalid_scale');
  if (line.minScale && scale < line.minScale - 1e-9) throw bad('That size is smaller than this item allows.', 'invalid_scale');
  if (line.maxScale && scale > line.maxScale + 1e-9) throw bad('That size is larger than this item allows.', 'invalid_scale');
  const infill = Math.round(Number(line.infill));
  const [minInfill, maxInfill] = ctx.infillRange;
  if (!(infill >= minInfill && infill <= maxInfill)) throw bad(`Infill must be between ${minInfill}% and ${maxInfill}%.`, 'invalid_infill');
  const quantity = Math.round(Number(line.quantity || 1));
  if (!(quantity >= 1 && quantity <= 50)) throw bad('Quantity must be between 1 and 50.', 'invalid_quantity');
  const a = line.analysis;
  const unitWeight = engine.estimateWeightGrams({ volumeMm3: a.volumeMm3, areaMm2: a.areaMm2, scale, infillPercent: infill, wallMm: ctx.wallMm, density: mat.density });
  const unitFilament = engine.filamentCostCents(unitWeight, mat.price_per_gram);
  const printability = checkPrintability(a, scale, ctx.printers, line.material, { maxModelMm: ctx.maxModelMm, minWallMm: ctx.minWallMm });
  return {
    material: mat.code, materialName: { en: mat.name_en, ar: mat.name_ar },
    color: color.code, colorName: { en: color.name_en, ar: color.name_ar }, colorHex: color.hex,
    scale, infill, quantity,
    sizeMm: printability.sizeMm.map((v) => Math.round(v * 10) / 10),
    unitWeightGrams: Math.round(unitWeight * 10) / 10,
    weightGrams: Math.round(unitWeight * quantity * 10) / 10,
    unitFilamentCents: unitFilament, filamentCents: unitFilament * quantity,
    printability,
  };
}

/** Full quote for priced lines delivered to { country, region }. */
export function quoteLines(ctx, pricedLines, destination) {
  const country = String(destination?.country || ctx.defaultCountry).toUpperCase();
  const region = destination?.region || '';
  const filamentCents = pricedLines.reduce((s, l) => s + l.filamentCents, 0);
  const taxRate = engine.findTaxRate(ctx.taxRates, country, region);
  const tax = engine.taxCents(filamentCents, taxRate.rate);
  const zone = engine.findShippingZone(ctx.zones, country);
  const pkg = engine.packageFor(pricedLines.map((l) => ({ sizeMm: l.sizeMm, weightGrams: l.unitWeightGrams, quantity: l.quantity })));
  const ship = zone ? engine.shippingCents(pkg, zone) : null;
  const breakdown = engine.priceBreakdown({ filamentCents, taxCents: tax, shippingCents: ship ? ship.cents : 0, feeTiers: ctx.feeTiers });
  const display = currencyFor(ctx, country);
  return {
    currency: ctx.currency,
    display: { currency: display.code, rate: display.rate, decimals: display.decimals, total: convert(breakdown.totalCents, display) },
    destination: { country, region },
    lines: pricedLines,
    taxRate: { rate: taxRate.rate, label: taxRate.label || null },
    shipping: zone ? {
      zone: { id: zone.id, en: zone.name_en, ar: zone.name_ar }, billableKg: ship.billableKg,
      packageWeightGrams: Math.round(pkg.weightGrams), packageDimsMm: pkg.dimsMm.map((v) => Math.round(v)), days: [zone.min_days, zone.max_days],
    } : null,
    shipsToDestination: Boolean(zone),
    breakdown,
    printable: pricedLines.every((l) => l.printability.ok),
  };
}
