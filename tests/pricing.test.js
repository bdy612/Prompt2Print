import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  priceBreakdown, serviceFee, percentOf, estimateWeightGrams, filamentCostCents, taxCents,
  shippingCents, packageFor, findTaxRate, findShippingZone, DEFAULT_FEE_TIERS,
} from '../server/pricing/engine.js';

test('spec example 1: $3.00 + $0.45 + $8.00 → 15% fee → $13.17', () => {
  const b = priceBreakdown({ filamentCents: 300, taxCents: 45, shippingCents: 800 });
  assert.equal(b.subtotalCents, 1145);
  assert.equal(b.feePercent, 15);
  assert.equal(b.feeCents, 172);
  assert.equal(b.totalCents, 1317);
});

test('spec example 2: $60.00 + $9.00 + $40.00 → 5% fee → $114.45', () => {
  const b = priceBreakdown({ filamentCents: 6000, taxCents: 900, shippingCents: 4000 });
  assert.equal(b.subtotalCents, 10900);
  assert.equal(b.feePercent, 5);
  assert.equal(b.feeCents, 545);
  assert.equal(b.totalCents, 11445);
});

test('fee threshold: exactly $100 is "100 or less" → 15%', () => {
  assert.equal(serviceFee(10000).percent, 15);
  assert.equal(serviceFee(10001).percent, 5);
  assert.equal(serviceFee(0).cents, 0);
});

test('admin-edited fee tiers are honoured', () => {
  const tiers = [{ maxCents: 5000, percent: 20 }, { maxCents: 20000, percent: 10 }, { maxCents: null, percent: 3 }];
  assert.equal(serviceFee(4000, tiers).percent, 20);
  assert.equal(serviceFee(15000, tiers).percent, 10);
  assert.equal(serviceFee(25000, tiers).percent, 3);
});

test('tax is applied to the filament cost only, rounded half up', () => {
  assert.equal(taxCents(300, 15), 45);
  assert.equal(taxCents(6000, 15), 900);
  assert.equal(taxCents(333, 7.25), 24); // 24.14
  assert.equal(percentOf(1, 50), 1);    // 0.5 rounds up
});

test('weight: solid cube vs. 20% infill', () => {
  // 20 mm cube: volume 8000 mm³, area 2400 mm²
  const solid = estimateWeightGrams({ volumeMm3: 8000, areaMm2: 2400, infillPercent: 100, wallMm: 1.2, density: 1.24 });
  assert.ok(Math.abs(solid - 9.92) < 1e-9);
  const sparse = estimateWeightGrams({ volumeMm3: 8000, areaMm2: 2400, infillPercent: 20, wallMm: 1.2, density: 1.24 });
  // shell 2880 mm³ + 20% of 5120 mm³ = 3904 mm³ → 4.84 g
  assert.ok(Math.abs(sparse - 4.84096) < 1e-6);
  // Doubling the size scales the volume ×8 and the shell ×4
  const big = estimateWeightGrams({ volumeMm3: 8000, areaMm2: 2400, scale: 2, infillPercent: 20, wallMm: 1.2, density: 1.24 });
  assert.ok(big > sparse * 4 && big < sparse * 8);
});

test('filament cost', () => {
  assert.equal(filamentCostCents(120, 0.025), 300);
});

test('shipping uses the larger of actual and volumetric weight, in 0.5 kg steps', () => {
  const zone = { base_cents: 500, per_kg_cents: 600, volumetric_divisor: 5000 };
  // 130×130×140 mm box → 2.366 kg/5000… = 0.47 kg volumetric → 0.5 kg billable
  const s = shippingCents({ weightGrams: 200, dimsMm: [130, 130, 140] }, zone);
  assert.equal(s.billableKg, 0.5);
  assert.equal(s.cents, 800);
  const heavy = shippingCents({ weightGrams: 2100, dimsMm: [100, 100, 100] }, zone);
  assert.equal(heavy.billableKg, 2.5);
  assert.equal(heavy.cents, 500 + 1500);
});

test('package combines items and adds packaging weight', () => {
  const one = packageFor([{ sizeMm: [80, 80, 95], weightGrams: 100, quantity: 1 }]);
  assert.deepEqual(one.dimsMm, [100, 100, 115]);
  assert.equal(one.weightGrams, 100 + 60 + 5);
  const two = packageFor([{ sizeMm: [80, 80, 95], weightGrams: 100, quantity: 2 }]);
  assert.ok(two.weightGrams > one.weightGrams);
});

test('tax and zone lookup with fallbacks', () => {
  const rates = [
    { country: 'SA', region: '*', rate: 15 },
    { country: 'US', region: 'CA', rate: 7.25 },
    { country: 'US', region: '*', rate: 0 },
    { country: '*', region: '*', rate: 0 },
  ];
  assert.equal(findTaxRate(rates, 'sa').rate, 15);
  assert.equal(findTaxRate(rates, 'US', 'ca').rate, 7.25);
  assert.equal(findTaxRate(rates, 'US', 'NY').rate, 0);
  assert.equal(findTaxRate(rates, 'FR').rate, 0);
  const zones = [
    { id: 1, countries: ['SA'], active: 1 },
    { id: 2, countries: ['*'], active: 1 },
  ];
  assert.equal(findShippingZone(zones, 'SA').id, 1);
  assert.equal(findShippingZone(zones, 'JP').id, 2);
  assert.equal(DEFAULT_FEE_TIERS.length, 2);
});
