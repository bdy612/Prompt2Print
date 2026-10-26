// Tests for the offline demo prompt → 3D generator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateFromPrompt, DEMO_CATEGORIES } from '../server/ai/procedural.js';
import { edgeTopology, countDegenerate } from '../server/mesh/analyze.js';
import { signedVolume, computeBBox } from '../server/mesh/core.js';

const PROMPTS = [
  // English
  ['a pen holder shaped like a castle with a dragon handle', 'pen_holder'],
  ['honeycomb pen holder', 'pen_holder'],
  ['tall twisted star vase', 'vase'],
  ['vase', 'vase'],
  ['wide wavy vase', 'vase'],
  ['hexagon planter', 'planter'],
  ['small planter', 'planter'],
  ['pen holder', 'pen_holder'],
  ['gear pen holder', 'pen_holder'],
  ['lamp shade', 'lamp'],
  ['spiral lamp', 'lamp'],
  ['headphone stand', 'headphone_stand'],
  ['cable organizer', 'cable'],
  ['bookend', 'bookend'],
  ['wall key holder hook', 'hook'],
  ['dice', 'dice'],
  ['owl figurine', 'sculpture'],
  ['sitting cat figurine', 'sculpture'],
  ['trinket box with lid', 'organizer'],
  ['trophy', 'trophy'],
  ['rocket', 'rocket'],
  ['castle', 'castle'],
  ['castle tower', 'castle'],
  ['faceted tower', 'castle'],
  ['ornament', 'ornament'],
  ['star ornament', 'ornament'],
  ['dragon egg', 'sculpture'],
  ['a cute cat', 'sculpture'],
  ['low-poly sculpture', 'sculpture'],
  ['chess set', 'chess'],
  ['chess pawn', 'chess'],
  ['chess rook', 'chess'],
  ['chess knight', 'chess'],
  ['bishop', 'chess'],
  ['chess queen', 'chess'],
  ['twisted chess king', 'chess'],
  ['heart keychain', 'keychain'],
  ['castle keychain', 'keychain'],
  ['keychain', 'keychain'],
  ['phone stand', 'phone_stand'],
  ['dragon phone stand', 'phone_stand'],
  ['desk organizer', 'organizer'],
  ['box with lid', 'organizer'],
  ['large castle', 'castle'],
  // Arabic
  ['حامل أقلام على شكل قلعة بمقبض تنين', 'pen_holder'],
  ['مزهرية ملتوية طويلة', 'vase'],
  ['أصيص زرع سداسي', 'planter'],
  ['حامل أقلام', 'pen_holder'],
  ['طقم شطرنج', 'chess'],
  ['ملك الشطرنج', 'chess'],
  ['ميدالية مفاتيح على شكل قلب', 'keychain'],
  ['حامل جوال', 'phone_stand'],
  ['صندوق بغطاء', 'organizer'],
  ['قلعة', 'castle'],
  ['بيضة تنين', 'sculpture'],
  ['مصباح حلزوني', 'lamp'],
  ['صاروخ', 'rocket'],
  ['حامل سماعات', 'headphone_stand'],
  ['نرد', 'dice'],
  ['مجسم بومة', 'sculpture'],
  ['زينة نجمة', 'ornament'],
];

const SEEDS = [1, 2, 3];
const CATEGORY_IDS = new Set(DEMO_CATEGORIES.map((c) => c.id));

function checkMesh(prompt, seed) {
  const t0 = performance.now();
  const { mesh, info } = generateFromPrompt(prompt, { seed });
  const ms = performance.now() - t0;
  const label = `"${prompt}" seed ${seed}`;
  assert.ok(mesh.positions instanceof Float32Array, `${label}: positions type`);
  assert.ok(mesh.indices instanceof Uint32Array, `${label}: indices type`);
  const topo = edgeTopology(mesh);
  assert.equal(topo.boundaryEdges, 0, `${label}: open edges`);
  assert.equal(topo.nonManifoldEdges, 0, `${label}: non-manifold edges`);
  assert.equal(topo.flippedEdges, 0, `${label}: flipped edges`);
  assert.equal(countDegenerate(mesh), 0, `${label}: degenerate triangles`);
  assert.ok(signedVolume(mesh) > 0, `${label}: volume must be positive`);
  const bb = computeBBox(mesh);
  assert.ok(Math.abs(bb.min[2]) < 1e-3, `${label}: rests on the bed (minZ ${bb.min[2]})`);
  assert.ok(Math.abs(bb.min[0] + bb.max[0]) < 1e-2 && Math.abs(bb.min[1] + bb.max[1]) < 1e-2, `${label}: centred on X/Y`);
  const largest = Math.max(...bb.size);
  assert.ok(largest >= 20 && largest <= 260, `${label}: plausible size (${bb.size.map((v) => v.toFixed(0)).join('×')})`);
  const tris = mesh.indices.length / 3;
  assert.ok(tris >= 12 && tris <= 90000, `${label}: triangle count ${tris}`);
  assert.ok(ms < 1500, `${label}: took ${ms.toFixed(0)} ms`);
  for (const k of ['titleEn', 'titleAr', 'descriptionEn', 'descriptionAr']) assert.ok(info[k] && info[k].length > 2, `${label}: ${k}`);
  assert.ok(CATEGORY_IDS.has(info.category), `${label}: category ${info.category}`);
  assert.ok(Array.isArray(info.keywords), `${label}: keywords`);
  return { mesh, info };
}

for (const [prompt, expected] of PROMPTS) {
  test(`generates a printable model: ${prompt}`, () => {
    const results = SEEDS.map((s) => checkMesh(prompt, s));
    assert.equal(results[0].info.category, expected, `category for "${prompt}"`);
    // Same prompt and seed → identical model.
    const again = generateFromPrompt(prompt, { seed: 1 }).mesh;
    assert.deepEqual(Array.from(again.positions), Array.from(results[0].mesh.positions), 'deterministic');
    // Different seeds → a different variation.
    const differs = (a, b) => a.positions.length !== b.positions.length || a.positions.some((v, i) => Math.abs(v - b.positions[i]) > 1e-4);
    assert.ok(differs(results[0].mesh, results[1].mesh) || differs(results[0].mesh, results[2].mesh), 'seeds give variations');
  });
}

test('the castle pen holder example reads naturally', () => {
  const { info } = generateFromPrompt('a pen holder shaped like a castle with a dragon handle', { seed: 1 });
  assert.equal(info.titleEn, 'Castle pen holder with dragon handle');
  assert.match(info.titleAr, /أقلام/);
  assert.match(info.titleAr, /تنين/);
  assert.match(info.descriptionEn, /dragon handle/);
});

test('food and drink prompts are never turned into food items', () => {
  for (const p of ['coffee mug', 'bowl', 'tea cup with handle']) {
    const { info } = generateFromPrompt(p, { seed: 1 });
    assert.ok(!/mug|cup|bowl/i.test(info.titleEn), `${p} → ${info.titleEn}`);
  }
});

test('the knight is a horse head: muzzle in front, ears on top', () => {
  const { mesh } = generateFromPrompt('chess knight', { seed: 1 });
  const bb = computeBBox(mesh);
  assert.ok(bb.size[0] > bb.size[1] * 1.1, 'longer front-to-back than wide');
  assert.ok(bb.size[2] > bb.size[0] * 1.1, 'taller than long');
});

test('respects a size given in the prompt', () => {
  const { mesh } = generateFromPrompt('a 15 cm tall vase', { seed: 4 });
  const bb = computeBBox(mesh);
  assert.ok(Math.abs(bb.size[2] - 150) < 3, `height ${bb.size[2]}`);
  const ar = generateFromPrompt('مزهرية بارتفاع ٢٠ سم', { seed: 2 }).mesh;
  assert.ok(Math.abs(computeBBox(ar).size[2] - 200) < 4, `arabic height ${computeBBox(ar).size[2]}`);
});

test('every listed category can be produced', () => {
  const seen = new Set();
  for (const [prompt] of PROMPTS) seen.add(generateFromPrompt(prompt, { seed: 1 }).info.category);
  for (const id of CATEGORY_IDS) assert.ok(seen.has(id), `no prompt produced ${id}`);
});
