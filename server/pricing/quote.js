// Quotes: combines the pricing engine with the admin's settings (materials, taxes, shipping zones,
// fee tiers) and the model's geometry. Used by the product page, AI Create, the cart and checkout,
// so the customer sees the same numbers everywhere and the server re-checks them at checkout.

import { all, getSetting, parseJson } from '../db.js';
import * as engine from './engine.js';
import { checkPrintability } from '../mesh/analyze.js';
import { bad } from '../lib/http.js';
import { config } from '../config.js';
import { currencyFor, convert, BASE_CURRENCY } from '../lib/currency.js';

export function loadPricingContext() {
  const materials = {};
  for (const m of all('SELECT * FROM materials ORDER BY sort')) {
    materials[m.code] = { ...m, colors: parseJson(m.colors, []) };
  }
  const zones = all('SELECT * FROM shipping_zones ORDER BY sort, id').map((z) => ({ ...z, countries: parseJson(z.countries, []) }));
  const printers = all('SELECT * FROM printers WHERE active = 1').map((p) => ({
    id: p.id, name: p.name, active: true, bed: parseJson(p.bed), materials: parseJson(p.materials, []),
  }));
  // Until the real printer is set up, price against the shop's standard printer so the catalog still works.
  if (!printers.length) printers.push({ id: 0, name: 'Bambu Lab P2S', active: true, bed: { x: 256, y: 256, z: 256 }, materials: Object.keys(materials) });
  return {
    materials,
    taxRates: all('SELECT * FROM tax_rates'),
    zones,
    printers,
    feeTiers: getSetting('fee_tiers', engine.DEFAULT_FEE_TIERS),
    wallMm: Number(getSetting('wall_thickness_mm', 2.1)),
    currency: BASE_CURRENCY,
    infillRange: getSetting('infill_range', [30, 40]),
    maxModelMm: config.maxModelMm,
    minWallMm: Number(getSetting('min_wall_mm', 2)),
  };
}

/**
 * Price one line (a product or an AI design) before tax/shipping/fee.
 * line: { analysis, material, color, scale, infill, quantity, allowedMaterials?, minScale?, maxScale? }
 */
export function priceLine(ctx, line) {
  const mat = ctx.materials[line.material];
  if (!mat || !mat.active) throw bad(`Material ${line.material} is not available.`, 'invalid_material');
  if (line.allowedMaterials && !line.allowedMaterials.includes(line.material)) throw bad(`${line.material} is not offered for this item.`, 'invalid_material');
  const color = mat.colors.find((c) => c.code === line.color) || null;
  if (!color) throw bad('Pick one of the listed colours.', 'invalid_color');
  if (color.in_stock === false || color.in_stock === 0) throw bad('That colour is out of stock right now. Pick another colour.', 'color_out_of_stock');
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
  const unitWeight = engine.estimateWeightGrams({
    volumeMm3: a.volumeMm3, areaMm2: a.areaMm2, scale, infillPercent: infill, wallMm: ctx.wallMm, density: mat.density,
  });
  const unitFilament = engine.filamentCostCents(unitWeight, mat.price_per_gram);
  const printability = checkPrintability(a, scale, ctx.printers, line.material, { maxModelMm: ctx.maxModelMm, minWallMm: ctx.minWallMm });
  return {
    material: mat.code,
    materialName: { en: mat.name_en, ar: mat.name_ar },
    color: color.code,
    colorName: { en: color.name_en, ar: color.name_ar },
    colorHex: color.hex,
    scale,
    infill,
    quantity,
    sizeMm: printability.sizeMm.map((v) => Math.round(v * 10) / 10),
    unitWeightGrams: Math.round(unitWeight * 10) / 10,
    weightGrams: Math.round(unitWeight * quantity * 10) / 10,
    pricePerGram: mat.price_per_gram,
    unitFilamentCents: unitFilament,
    filamentCents: unitFilament * quantity,
    printability,
  };
}

/**
 * Full quote for one or more priced lines delivered to `destination` ({ country, region }).
 */
export function quoteLines(ctx, pricedLines, destination) {
  const country = (destination?.country || getSetting('default_country', 'SA')).toUpperCase();
  const region = destination?.region || '';
  const filamentCents = pricedLines.reduce((s, l) => s + l.filamentCents, 0);
  const taxRate = engine.findTaxRate(ctx.taxRates, country, region);
  const tax = engine.taxCents(filamentCents, taxRate.rate);
  const zone = engine.findShippingZone(ctx.zones, country);
  const pkg = engine.packageFor(pricedLines.map((l) => ({ sizeMm: l.sizeMm, weightGrams: l.unitWeightGrams, quantity: l.quantity })));
  const ship = zone ? engine.shippingCents(pkg, zone) : null;
  const shipping = ship ? ship.cents : 0;
  const breakdown = engine.priceBreakdown({ filamentCents, taxCents: tax, shippingCents: shipping, feeTiers: ctx.feeTiers });
  const display = currencyFor(country);
  return {
    currency: ctx.currency,
    display: { currency: display.code, rate: display.rate, decimals: display.decimals, total: convert(breakdown.totalCents, display) },
    destination: { country, region },
    lines: pricedLines,
    taxRate: { rate: taxRate.rate, label: taxRate.label || null },
    shipping: zone
      ? {
          zone: { id: zone.id, en: zone.name_en, ar: zone.name_ar },
          billableKg: ship.billableKg,
          packageWeightGrams: Math.round(pkg.weightGrams),
          packageDimsMm: pkg.dimsMm.map((v) => Math.round(v)),
          days: [zone.min_days, zone.max_days],
        }
      : null,
    shipsToDestination: Boolean(zone),
    breakdown,
    printable: pricedLines.every((l) => l.printability.ok),
  };
}

export function feeTiersForDisplay(ctx) {
  return ctx.feeTiers;
}
