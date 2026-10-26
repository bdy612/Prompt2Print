// Admin API. Every route requires an admin account.

import { all, get, run, tx, parseJson, getSetting, setSetting } from '../db.js';
import { bad, notFound, readJson, readBody } from '../lib/http.js';
import { requireAdmin } from '../auth.js';
import { loadPricingContext } from '../pricing/quote.js';
import { DEFAULT_FEE_TIERS } from '../pricing/engine.js';
import { getOrderById, advanceFulfilment, cancelOrder, setStatus, addEvent } from '../orders.js';
import { refundPayment } from '../payments/index.js';
import {
  queueSnapshot, moveJob, pauseJob, resumeJob, cancelJob, reprintJob, clearPrinter, testPrinter, kick,
} from '../printing/queue.js';
import { DRIVERS } from '../printing/drivers/index.js';
import { providers } from '../ai/providers.js';
import { generateFromPrompt } from '../ai/procedural.js';
import { checkPromptPolicy } from '../designs.js';
import { saveModel, renderPhotos, getModel } from '../models.js';
import { parseAny } from '../mesh/formats.js';
import { repairMesh } from '../mesh/repair.js';
import { fitToSize, placeOnBed } from '../mesh/core.js';
import { publicAnalysis } from './helpers.js';
import { config } from '../config.js';
import { SLICER_NAME_RX } from '../printing/slicer.js';
import { findBambuStudio, BAMBU_STUDIO_RX } from '../printing/bambu-slicer.js';
import { encryptSecret, decryptSecret, maskSecret } from '../lib/secrets.js';
import { audit } from '../auth.js';
import { currencies, saveCurrencies, DEFAULT_CURRENCIES, COUNTRY_CURRENCY } from '../lib/currency.js';

const SECRET_KEYS = ['meshy_api_key', 'tripo_api_key', 'tap_secret_key', 'tap_publishable_key', 'stripe_secret_key', 'stripe_webhook_secret'];
const mask = (v) => maskSecret(decryptSecret(v));

function slugify(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').slice(0, 60) || `item-${Date.now()}`;
}

function uniqueSlug(base, ignoreId = null) {
  let slug = slugify(base);
  let n = 2;
  while (get('SELECT 1 FROM products WHERE slug = ? AND id != ?', [slug, ignoreId ?? -1])) slug = `${slugify(base)}-${n++}`;
  return slug;
}

function productAdminDTO(p) {
  const model = p.model_id ? getModel(p.model_id) : null;
  return {
    id: p.id, slug: p.slug, categoryId: p.category_id, modelId: p.model_id,
    name: { en: p.name_en, ar: p.name_ar }, description: { en: p.desc_en, ar: p.desc_ar },
    defaultMaterial: p.default_material, defaultColor: p.default_color, allowedMaterials: parseJson(p.allowed_materials, []),
    defaultScale: p.default_scale, minScale: p.min_scale, maxScale: p.max_scale, defaultInfill: p.default_infill,
    images: parseJson(p.images, []), tags: p.tags, featured: Boolean(p.featured), active: Boolean(p.active),
    rating: p.rating_avg, ratingCount: p.rating_count, soldCount: p.sold_count,
    analysis: model ? { ...publicAnalysis(model.analysis), overhangMm2: Math.round(model.analysis.overhangAreaMm2) } : null,
  };
}

function printerDTO(p) {
  const job = p.current_job_id ? get(`SELECT j.id, j.progress, j.stats, o.number, i.title_en, i.title_ar, i.thumb, i.material, i.color_hex
    FROM print_jobs j JOIN orders o ON o.id = j.order_id JOIN order_items i ON i.id = j.order_item_id WHERE j.id = ?`, p.current_job_id) : null;
  return {
    id: p.id, name: p.name, driver: p.driver, driverLabel: DRIVERS[p.driver]?.label || p.driver,
    url: p.url, serial: p.serial, hasApiKey: Boolean(p.api_key), hasAccessCode: Boolean(p.access_code), ams: parseJson(p.ams, []),
    flavor: p.flavor, bed: parseJson(p.bed), materials: parseJson(p.materials, []), slicerProfile: p.slicer_profile,
    active: Boolean(p.active), status: p.status, detail: p.driver === 'simulator' ? null : p.status_detail,
    progress: p.progress, lastSeen: p.last_seen,
    job: job && { id: job.id, progress: job.progress, orderNumber: job.number, title: { en: job.title_en, ar: job.title_ar }, thumb: job.thumb, material: job.material, colorHex: job.color_hex, stats: parseJson(job.stats) },
  };
}

function orderAdminDTO(o) {
  const user = o.user_id ? get('SELECT id, name, email FROM users WHERE id = ?', o.user_id) : null;
  return {
    id: o.id, number: o.number, status: o.status, totalCents: o.total_cents, currency: o.currency, refundedCents: o.refunded_cents,
    createdAt: o.created_at, paidAt: o.paid_at, carrier: o.carrier, trackingNumber: o.tracking_number,
    paymentProvider: o.payment_provider, paymentRef: o.payment_ref, customer: user,
    address: o.address, pricing: o.pricing, events: o.events,
    items: o.items.map((i) => ({
      id: i.id, title: { en: i.title_en, ar: i.title_ar }, thumb: i.thumb, kind: i.kind, material: i.material, color: i.color, colorHex: i.color_hex,
      scale: i.scale, infill: i.infill, quantity: i.quantity, sizeMm: i.size_mm, weightGrams: i.weight_g, filamentCents: i.filament_cents, needsSupports: Boolean(i.needs_supports),
    })),
    jobs: o.jobs,
    refunds: all('SELECT amount_cents, reason, created_at FROM refunds WHERE order_id = ? ORDER BY id', o.id),
  };
}

export function registerAdminRoutes(r) {
  const A = (handler) => async (req, res) => { requireAdmin(req); return handler(req, res); };

  // Overview ---------------------------------------------------------------------------------
  r.get('/api/admin/overview', A(() => {
    const today = get(`SELECT COUNT(*) AS n, COALESCE(SUM(total_cents),0) AS cents FROM orders WHERE paid_at >= date('now')`);
    const month = get(`SELECT COUNT(*) AS n, COALESCE(SUM(total_cents - refunded_cents),0) AS cents FROM orders WHERE paid_at >= date('now','-30 day')`);
    const counts = Object.fromEntries(all('SELECT status, COUNT(*) AS n FROM orders GROUP BY status').map((x) => [x.status, x.n]));
    const jobCounts = Object.fromEntries(all("SELECT status, COUNT(*) AS n FROM print_jobs WHERE status NOT IN ('printed','cancelled') GROUP BY status").map((x) => [x.status, x.n]));
    return {
      today, month, orderCounts: counts, jobCounts,
      printers: all('SELECT * FROM printers ORDER BY id').map(printerDTO),
      recentOrders: all('SELECT id FROM orders ORDER BY created_at DESC LIMIT 8').map((o) => orderAdminDTO(getOrderById(o.id))),
      aiDesignsToday: get("SELECT COUNT(*) AS n FROM designs WHERE created_at >= date('now')").n,
    };
  }));

  // Settings (fees, store, integrations) -----------------------------------------------------------
  r.get('/api/admin/settings', A(() => {
    const out = {
      store_name: getSetting('store_name', 'Prompt2Print'),
      currency: getSetting('currency', 'USD'),
      default_country: getSetting('default_country', 'SA'),
      wall_thickness_mm: getSetting('wall_thickness_mm', 1.2),
      fee_tiers: getSetting('fee_tiers', DEFAULT_FEE_TIERS),
      ai_provider: getSetting('ai_provider', 'demo'),
      ai_hourly_limit: getSetting('ai_hourly_limit', 30),
      ai_default_size_mm: getSetting('ai_default_size_mm', 100),
      payment_provider: getSetting('payment_provider', 'test'),
      slicer_path: getSetting('slicer_path', ''),
      bambu_studio_path: getSetting('bambu_studio_path', ''),
      bambu_studio_found: Boolean(findBambuStudio()),
      slicer_editable: config.desktop,
      currencies: currencies(),
      country_currency: COUNTRY_CURRENCY,
      fallback_currency: getSetting('fallback_currency', 'USD'),
      infill_range: getSetting('infill_range', [30, 40]),
      min_wall_mm: getSetting('min_wall_mm', 2),
      max_model_mm: config.maxModelMm,
      admin_email: config.adminEmail,
      simulator_speed: getSetting('simulator_speed', 400),
      simulator_failure_rate: getSetting('simulator_failure_rate', 0),
      simulator_auto_clear: getSetting('simulator_auto_clear', true),
      providers: Object.values(providers).map((p) => ({ id: p.id, label: p.label, configured: p.configured() })),
    };
    for (const k of SECRET_KEYS) out[k] = mask(getSetting(k, ''));
    return out;
  }));

  r.put('/api/admin/settings', A(async (req) => {
    const b = await readJson(req);
    if (b.fee_tiers !== undefined) {
      const tiers = (Array.isArray(b.fee_tiers) ? b.fee_tiers : []).map((t) => ({
        maxCents: t.maxCents === null || t.maxCents === '' || t.maxCents === undefined ? null : Math.round(Number(t.maxCents)),
        percent: Number(t.percent),
      }));
      if (!tiers.length || tiers.some((t) => !(t.percent >= 0 && t.percent <= 100) || (t.maxCents !== null && !(t.maxCents >= 0)))) {
        throw bad('Each fee tier needs a percentage from 0 to 100 and a valid threshold.');
      }
      if (!tiers.some((t) => t.maxCents === null)) throw bad('Add a final tier with no upper limit ("and above").');
      setSetting('fee_tiers', tiers.sort((a, c) => (a.maxCents ?? Infinity) - (c.maxCents ?? Infinity)));
    }
    const plain = {
      store_name: (v) => String(v).slice(0, 60),
      currency: (v) => String(v).toUpperCase().slice(0, 3),
      default_country: (v) => String(v).toUpperCase().slice(0, 2),
      wall_thickness_mm: (v) => { const n = Number(v); if (!(n >= 0.4 && n <= 5)) throw bad('Wall thickness must be between 0.4 and 5 mm.'); return n; },
      ai_provider: (v) => { if (v !== 'auto' && !providers[v]) throw bad('Unknown AI provider.'); return v; },
      fallback_currency: (v) => { const c = String(v).toUpperCase(); if (!currencies().some((x) => x.code === c)) throw bad('Unknown currency.'); return c; },
      min_wall_mm: (v) => { const n = Number(v); if (!(n >= 1 && n <= 5)) throw bad('Minimum wall must be between 1 and 5 mm.'); return n; },
      infill_range: (v) => { const [a, b] = (Array.isArray(v) ? v : []).map(Number); if (!(a >= 5 && b <= 100 && a <= b)) throw bad('Infill range must be within 5–100%.'); return [Math.round(a), Math.round(b)]; },
      ai_hourly_limit: (v) => Math.max(1, Math.round(Number(v))),
      ai_default_size_mm: (v) => Math.min(250, Math.max(20, Number(v))),
      payment_provider: (v) => (['tap', 'stripe', 'test'].includes(v) ? v : 'tap'),
      // The slicer is a program the server runs, so it can only be chosen here in the Windows app
      // (the shop owner's own PC). Online deployments set SLICER_PATH in the environment instead.
      bambu_studio_path: (v) => {
        const value = String(v).trim();
        if (!value) return '';
        if (!config.desktop) throw bad('Set Bambu Studio with the BAMBU_STUDIO_PATH environment variable on the server.');
        if (!BAMBU_STUDIO_RX.test(value.split(/[\\/]/).pop())) throw bad('Choose bambu-studio.exe or orca-slicer.exe.');
        return value;
      },
      slicer_path: (v) => {
        const value = String(v).trim();
        if (!value) return '';
        if (!config.desktop) throw bad('Set the slicer with the SLICER_PATH environment variable on the server.');
        if (!SLICER_NAME_RX.test(value.split(/[\\/]/).pop())) throw bad('Choose PrusaSlicer or SuperSlicer (for example prusa-slicer-console.exe).');
        return value;
      },
      simulator_speed: (v) => Math.min(3600, Math.max(1, Number(v))),
      simulator_failure_rate: (v) => Math.min(100, Math.max(0, Number(v))),
      simulator_auto_clear: (v) => Boolean(v),
    };
    for (const [k, fn] of Object.entries(plain)) if (b[k] !== undefined) setSetting(k, fn(b[k]));
    const changedSecrets = [];
    for (const k of SECRET_KEYS) {
      if (typeof b[k] === 'string' && !b[k].startsWith('••••')) { setSetting(k, encryptSecret(b[k].trim())); changedSecrets.push(k); }
    }
    if (Array.isArray(b.currencies)) {
      const list = b.currencies.map((c) => ({ code: String(c.code || '').toUpperCase().slice(0, 3), rate: Number(c.rate), decimals: [0, 2, 3].includes(Number(c.decimals)) ? Number(c.decimals) : 2 }))
        .filter((c) => /^[A-Z]{3}$/.test(c.code) && c.rate > 0);
      if (!list.some((c) => c.code === 'SAR')) list.unshift(DEFAULT_CURRENCIES[0]);
      saveCurrencies(list);
    }
    audit(req, 'settings.update', { keys: Object.keys(b).filter((k) => !SECRET_KEYS.includes(k)), secrets: changedSecrets });
    return { ok: true };
  }));

  // Materials --------------------------------------------------------------------------------
  const matDTO = (m) => ({ ...m, colors: parseJson(m.colors, []), active: Boolean(m.active) });
  r.get('/api/admin/materials', A(() => all('SELECT * FROM materials ORDER BY sort').map(matDTO)));
  r.put('/api/admin/materials/:code', A(async (req) => {
    const b = await readJson(req);
    const code = req.params.code.toUpperCase();
    const existing = get('SELECT * FROM materials WHERE code = ?', code);
    const price = Number(b.price_per_gram);
    const density = Number(b.density);
    if (!(price > 0 && price < 50)) throw bad('Price per gram must be more than 0 and less than 50 SAR.');
    if (!(density > 0.5 && density < 3)) throw bad('Density must be between 0.5 and 3 g/cm³.');
    // The printer's limits: hardened-steel 0.4 nozzle up to 300 °C, bed up to 110 °C.
    if (b.nozzle_temp && Number(b.nozzle_temp) > 300) throw bad('Nozzle temperature must be 300 °C or less (printer limit).');
    if (b.bed_temp && Number(b.bed_temp) > 110) throw bad('Bed temperature must be 110 °C or less (printer limit).');
    const colors = (b.colors || []).filter((c) => c.code && /^#[0-9a-f]{6}$/i.test(c.hex)).map((c) => ({
      code: String(c.code).toLowerCase().replace(/[^a-z0-9-]/g, ''), name_en: String(c.name_en || c.code), name_ar: String(c.name_ar || c.name_en || c.code), hex: c.hex,
      in_stock: c.in_stock !== false && c.in_stock !== 0 && c.in_stock !== 'false',
    }));
    if (!colors.length) throw bad('Add at least one colour.');
    const vals = [b.name_en || code, b.name_ar || code, b.desc_en || '', b.desc_ar || '', price, density, b.process === 'resin' ? 'resin' : 'fdm',
      Number(b.nozzle_temp) || null, Number(b.bed_temp) || null, JSON.stringify(colors), b.active === false ? 0 : 1];
    if (existing) {
      run('UPDATE materials SET name_en=?, name_ar=?, desc_en=?, desc_ar=?, price_per_gram=?, density=?, process=?, nozzle_temp=?, bed_temp=?, colors=?, active=? WHERE code = ?', [...vals, code]);
    } else {
      run('INSERT INTO materials(name_en, name_ar, desc_en, desc_ar, price_per_gram, density, process, nozzle_temp, bed_temp, colors, active, code, sort) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,99)', [...vals, code]);
    }
    return matDTO(get('SELECT * FROM materials WHERE code = ?', code));
  }));

  // Tax rates --------------------------------------------------------------------------------
  r.get('/api/admin/taxes', A(() => all("SELECT * FROM tax_rates ORDER BY country = '*', country, region")));
  r.post('/api/admin/taxes', A(async (req) => {
    const b = await readJson(req);
    const country = String(b.country || '').toUpperCase().trim();
    const region = String(b.region || '*').trim() || '*';
    const rate = Number(b.rate);
    if (!(country === '*' || /^[A-Z]{2}$/.test(country))) throw bad('Use a 2-letter country code, or * for everywhere else.');
    if (!(rate >= 0 && rate <= 50)) throw bad('Tax rate must be between 0% and 50%.');
    run('INSERT INTO tax_rates(country, region, rate, label) VALUES(?, ?, ?, ?) ON CONFLICT(country, region) DO UPDATE SET rate = excluded.rate, label = excluded.label',
      [country, region === '*' ? '*' : region.toUpperCase(), rate, String(b.label || '').slice(0, 40)]);
    return { ok: true };
  }));
  r.delete('/api/admin/taxes/:id', A((req) => { run('DELETE FROM tax_rates WHERE id = ?', Number(req.params.id)); return { ok: true }; }));

  // Shipping zones ---------------------------------------------------------------------------
  const zoneDTO = (z) => ({ ...z, countries: parseJson(z.countries, []), active: Boolean(z.active) });
  r.get('/api/admin/shipping', A(() => all('SELECT * FROM shipping_zones ORDER BY sort, id').map(zoneDTO)));
  r.post('/api/admin/shipping', A(async (req) => saveZone(await readJson(req))));
  r.put('/api/admin/shipping/:id', A(async (req) => saveZone(await readJson(req), Number(req.params.id))));
  r.delete('/api/admin/shipping/:id', A((req) => { run('DELETE FROM shipping_zones WHERE id = ?', Number(req.params.id)); return { ok: true }; }));
  function saveZone(b, id = null) {
    const countries = String(Array.isArray(b.countries) ? b.countries.join(',') : b.countries || '').split(/[\s,]+/).map((c) => c.trim().toUpperCase()).filter(Boolean);
    if (!countries.length || countries.some((c) => c !== '*' && !/^[A-Z]{2}$/.test(c))) throw bad('List 2-letter country codes separated by commas, or * for the rest of the world.');
    const base = Math.round(Number(b.base_cents));
    const perKg = Math.round(Number(b.per_kg_cents));
    if (!(base >= 0) || !(perKg >= 0)) throw bad('Rates must be zero or more.');
    const vals = [b.name_en || 'Zone', b.name_ar || b.name_en || 'منطقة', JSON.stringify(countries), base, perKg, Math.round(Number(b.volumetric_divisor) || 5000),
      Math.round(Number(b.min_days) || 2), Math.round(Number(b.max_days) || 5), b.active === false ? 0 : 1];
    if (id) run('UPDATE shipping_zones SET name_en=?, name_ar=?, countries=?, base_cents=?, per_kg_cents=?, volumetric_divisor=?, min_days=?, max_days=?, active=? WHERE id = ?', [...vals, id]);
    else run('INSERT INTO shipping_zones(name_en, name_ar, countries, base_cents, per_kg_cents, volumetric_divisor, min_days, max_days, active) VALUES(?,?,?,?,?,?,?,?,?)', vals);
    return { ok: true };
  }

  // Printers ---------------------------------------------------------------------------------
  r.get('/api/admin/printers', A(() => ({
    printers: all('SELECT * FROM printers ORDER BY id').map(printerDTO),
    drivers: Object.entries(DRIVERS).map(([id, d]) => ({ id, label: d.label, fields: d.fields })),
  })));
  const printerVals = (b, existing = {}) => {
    if (!DRIVERS[b.driver]) throw bad('Choose a printer type.');
    const bed = { x: Number(b.bed?.x), y: Number(b.bed?.y), z: Number(b.bed?.z) };
    if (![bed.x, bed.y, bed.z].every((v) => v >= 50 && v <= 2000)) throw bad('Build volume must be between 50 and 2000 mm on each axis.');
    const materials = (b.materials || []).map((m) => String(m).toUpperCase());
    if (!materials.length) throw bad('Pick at least one material this printer can use.');
    if (b.driver !== 'simulator' && !b.url) throw bad('Enter the printer address (for example http://192.168.1.50).');
    if (b.driver === 'bambu' && b.active !== false && (!b.serial || !(b.access_code || existing.access_code))) throw bad('A Bambu printer needs its serial number and LAN access code before it can be activated.');
    const ams = (Array.isArray(b.ams) ? b.ams : []).map((s, i) => ({ slot: i + 1, material: String(s?.material || '').toUpperCase(), color: String(s?.color || '').toLowerCase() }))
      .filter((s) => s.material && s.color).slice(0, 16);
    return {
      name: String(b.name || 'Printer').slice(0, 60), driver: b.driver, url: b.url || null,
      api_key: b.api_key === undefined || String(b.api_key).startsWith('••••') ? existing.api_key ?? null : b.api_key || null,
      serial: b.serial || null,
      access_code: b.access_code === undefined || String(b.access_code).startsWith('••••') ? existing.access_code ?? null : b.access_code || null,
      flavor: ['marlin', 'klipper', 'bambu'].includes(b.flavor) ? b.flavor : 'marlin',
      bed: JSON.stringify(bed), materials: JSON.stringify(materials), slicer_profile: b.slicer_profile || null, active: b.active === false ? 0 : 1,
      ams: JSON.stringify(ams),
    };
  };
  r.post('/api/admin/printers', A(async (req) => {
    const v = printerVals(await readJson(req));
    run('INSERT INTO printers(name, driver, url, api_key, serial, access_code, flavor, bed, materials, slicer_profile, active, ams) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      [v.name, v.driver, v.url, v.api_key, v.serial, v.access_code, v.flavor, v.bed, v.materials, v.slicer_profile, v.active, v.ams]);
    audit(req, 'printer.create', { name: v.name });
    kick();
    return { ok: true };
  }));
  r.put('/api/admin/printers/:id', A(async (req) => {
    const existing = get('SELECT * FROM printers WHERE id = ?', Number(req.params.id));
    if (!existing) throw notFound();
    const v = printerVals(await readJson(req), existing);
    run('UPDATE printers SET name=?, driver=?, url=?, api_key=?, serial=?, access_code=?, flavor=?, bed=?, materials=?, slicer_profile=?, active=?, ams=? WHERE id = ?',
      [v.name, v.driver, v.url, v.api_key, v.serial, v.access_code, v.flavor, v.bed, v.materials, v.slicer_profile, v.active, v.ams, existing.id]);
    audit(req, 'printer.update', { id: existing.id, name: v.name, active: v.active });
    kick();
    return { ok: true };
  }));
  r.delete('/api/admin/printers/:id', A((req) => {
    const p = get('SELECT * FROM printers WHERE id = ?', Number(req.params.id));
    if (p?.current_job_id) throw bad('This printer is busy. Cancel or finish its job first.');
    run('DELETE FROM printers WHERE id = ?', Number(req.params.id));
    return { ok: true };
  }));
  r.post('/api/admin/printers/:id/clear', A((req) => { clearPrinter(Number(req.params.id)); return { ok: true }; }));
  r.post('/api/admin/printers/:id/test', A(async (req) => {
    const p = get('SELECT * FROM printers WHERE id = ?', Number(req.params.id));
    if (!p) throw notFound();
    try { return await testPrinter(p); } catch (err) { return { ok: false, message: err.message }; }
  }));

  // Print queue ------------------------------------------------------------------------------
  r.get('/api/admin/queue', A(() => queueSnapshot()));
  r.post('/api/admin/jobs/:id/:action', A(async (req) => {
    const id = Number(req.params.id);
    const action = req.params.action;
    if (action === 'up' || action === 'down' || action === 'top') moveJob(id, action);
    else if (action === 'pause') await pauseJob(id);
    else if (action === 'resume') await resumeJob(id);
    else if (action === 'cancel') await cancelJob(id);
    else if (action === 'reprint') reprintJob(id);
    else throw notFound();
    return { ok: true };
  }));

  // Products & models ------------------------------------------------------------------------
  r.get('/api/admin/products', A(() => all('SELECT * FROM products ORDER BY id DESC').map(productAdminDTO)));
  r.get('/api/admin/categories', A(() => all('SELECT * FROM categories ORDER BY sort, id')));
  r.post('/api/admin/categories', A(async (req) => {
    const b = await readJson(req);
    if (!b.name_en) throw bad('Enter a category name.');
    run('INSERT INTO categories(slug, name_en, name_ar, sort) VALUES(?, ?, ?, 99)', [slugify(b.name_en), b.name_en, b.name_ar || b.name_en]);
    return { ok: true };
  }));

  // Create a model for a product: from a prompt (built-in generator) or an uploaded STL/OBJ/GLB.
  r.post('/api/admin/models/generate', A(async (req) => {
    const b = await readJson(req);
    if (!b.prompt) throw bad('Describe the object.');
    checkPromptPolicy(String(b.prompt));
    const { mesh, info } = generateFromPrompt(String(b.prompt), { seed: Number(b.seed) || 1 });
    const m = saveModel(placeOnBed(mesh), { source: 'catalog' });
    return { modelId: m.id, analysis: publicAnalysis(m.analysis), suggested: { name_en: info.titleEn, name_ar: info.titleAr, desc_en: info.descriptionEn, desc_ar: info.descriptionAr }, preview: renderPhotos(m.id, { mesh, views: ['hero'], size: 480 })[0] };
  }));
  r.post('/api/admin/models/upload', A(async (req) => {
    const buf = await readBody(req, 150 * 1024 * 1024);
    const name = String(req.query.name || 'model.stl');
    let mesh;
    try { mesh = parseAny(buf, name); } catch (err) { throw bad(`Could not read this file: ${err.message}`); }
    const repaired = repairMesh(mesh);
    mesh = repaired.mesh;
    if (req.query.sizeMm) mesh = placeOnBed(fitToSize(mesh, Number(req.query.sizeMm)));
    const m = saveModel(mesh, { source: 'upload' });
    return { modelId: m.id, analysis: { ...publicAnalysis(m.analysis), repaired: repaired.report }, preview: renderPhotos(m.id, { mesh, views: ['hero'], size: 480 })[0] };
  }));

  const productVals = (b) => {
    const allowed = (b.allowedMaterials || []).map((m) => String(m).toUpperCase());
    const ctx = loadPricingContext();
    if (!allowed.length) throw bad('Allow at least one material.');
    if (!allowed.includes(b.defaultMaterial)) throw bad('The default material must be one of the allowed materials.');
    const mat = ctx.materials[b.defaultMaterial];
    if (!mat?.colors.some((c) => c.code === b.defaultColor)) throw bad('Pick a default colour of the default material.');
    const minScale = Number(b.minScale) || 0.5, maxScale = Number(b.maxScale) || 2, defScale = Number(b.defaultScale) || 1;
    if (!(minScale > 0 && minScale <= defScale && defScale <= maxScale)) throw bad('Sizes must be: minimum ≤ default ≤ maximum.');
    if (!b.name?.en) throw bad('Enter the English name.');
    return [b.categoryId ? Number(b.categoryId) : null, b.name.en, b.name.ar || b.name.en, b.description?.en || '', b.description?.ar || '',
      b.defaultMaterial, b.defaultColor, JSON.stringify(allowed), defScale, minScale, maxScale, Math.min(100, Math.max(5, Number(b.defaultInfill) || 20)),
      String(b.tags || ''), b.featured ? 1 : 0, b.active === false ? 0 : 1];
  };
  r.post('/api/admin/products', A(async (req) => {
    const b = await readJson(req);
    if (!b.modelId || !getModel(b.modelId)) throw bad('Generate or upload a model first.');
    const vals = productVals(b);
    const res2 = run(`INSERT INTO products(category_id, name_en, name_ar, desc_en, desc_ar, default_material, default_color, allowed_materials,
      default_scale, min_scale, max_scale, default_infill, tags, featured, active, slug, model_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [...vals, uniqueSlug(b.name.en), b.modelId]);
    const id = Number(res2.lastInsertRowid);
    rerender(id);
    run("UPDATE models SET source = 'catalog' WHERE id = ? AND source = 'upload'", b.modelId);
    return productAdminDTO(get('SELECT * FROM products WHERE id = ?', id));
  }));
  r.put('/api/admin/products/:id', A(async (req) => {
    const b = await readJson(req);
    const p = get('SELECT * FROM products WHERE id = ?', Number(req.params.id));
    if (!p) throw notFound();
    const vals = productVals(b);
    run(`UPDATE products SET category_id=?, name_en=?, name_ar=?, desc_en=?, desc_ar=?, default_material=?, default_color=?, allowed_materials=?,
      default_scale=?, min_scale=?, max_scale=?, default_infill=?, tags=?, featured=?, active=? WHERE id = ?`, [...vals, p.id]);
    if (b.default_color_changed || p.default_color !== b.defaultColor || p.default_material !== b.defaultMaterial) rerender(p.id);
    return productAdminDTO(get('SELECT * FROM products WHERE id = ?', p.id));
  }));
  r.delete('/api/admin/products/:id', A((req) => {
    const id = Number(req.params.id);
    if (get('SELECT 1 FROM order_items WHERE product_id = ?', id)) {
      run('UPDATE products SET active = 0 WHERE id = ?', id); // keep history for past orders
      return { ok: true, archived: true };
    }
    run('DELETE FROM products WHERE id = ?', id);
    return { ok: true };
  }));
  function rerender(productId) {
    const p = get('SELECT * FROM products WHERE id = ?', productId);
    const mat = loadPricingContext().materials[p.default_material];
    const hex = mat?.colors.find((c) => c.code === p.default_color)?.hex || '#D6246E';
    const images = renderPhotos(p.model_id, { color: hex, views: ['hero', 'iso', 'front', 'top'] });
    run('UPDATE products SET images = ? WHERE id = ?', [JSON.stringify(images), productId]);
  }

  // Orders -----------------------------------------------------------------------------------
  r.get('/api/admin/orders', A((req) => {
    const q = req.query;
    const where = [];
    const params = [];
    if (q.status) { where.push('o.status = ?'); params.push(q.status); }
    if (q.q) { where.push('(o.number LIKE ? OR u.email LIKE ? OR u.name LIKE ?)'); params.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`); }
    return all(`SELECT o.id FROM orders o LEFT JOIN users u ON u.id = o.user_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY o.created_at DESC LIMIT 200`, params)
      .map((o) => orderAdminDTO(getOrderById(o.id)));
  }));
  r.get('/api/admin/orders/:id', A((req) => {
    const o = getOrderById(Number(req.params.id));
    if (!o) throw notFound();
    return orderAdminDTO(o);
  }));
  r.post('/api/admin/orders/:id/advance', A(async (req) => {
    const b = await readJson(req);
    return orderAdminDTO(advanceFulfilment(Number(req.params.id), b.to, { carrier: b.carrier, trackingNumber: b.trackingNumber, note: b.note }));
  }));
  r.post('/api/admin/orders/:id/cancel', A(async (req) => {
    const b = await readJson(req);
    return orderAdminDTO(cancelOrder(Number(req.params.id), b.note || 'Cancelled by staff'));
  }));
  r.post('/api/admin/orders/:id/refund', A(async (req) => {
    const admin = requireAdmin(req);
    const b = await readJson(req);
    const o = getOrderById(Number(req.params.id));
    if (!o) throw notFound();
    if (!o.paid_at) throw bad('This order was never paid.');
    const remaining = o.total_cents - o.refunded_cents;
    const amount = Math.round(Number(b.amountCents ?? remaining));
    if (!(amount > 0 && amount <= remaining)) throw bad(`Refund must be between $0.01 and ${(remaining / 100).toFixed(2)}.`);
    const ref = await refundPayment(o, amount);
    tx(() => {
      run('INSERT INTO refunds(order_id, amount_cents, reason, provider_ref, created_by) VALUES(?, ?, ?, ?, ?)', [o.id, amount, String(b.reason || '').slice(0, 200), ref, admin.id]);
      run('UPDATE orders SET refunded_cents = refunded_cents + ? WHERE id = ?', [amount, o.id]);
      run("UPDATE payments SET status = 'refunded' WHERE order_id = ? AND status = 'succeeded' AND ? = 1", [o.id, amount === remaining ? 1 : 0]);
    });
    if (amount === remaining) {
      for (const j of all("SELECT id FROM print_jobs WHERE order_id = ? AND status NOT IN ('printed','cancelled')", o.id)) await cancelJob(j.id);
      setStatus(o.id, 'refunded', b.reason || null);
    } else {
      addEvent(o.id, o.status, `Partial refund $${(amount / 100).toFixed(2)}${b.reason ? `: ${b.reason}` : ''}`);
    }
    return orderAdminDTO(getOrderById(o.id));
  }));

  // Users ------------------------------------------------------------------------------------
  r.get('/api/admin/users', A((req) => {
    const q = req.query.q ? `%${req.query.q}%` : '%';
    return all(`SELECT u.id, u.email, u.name, u.role, u.locale, u.disabled, u.created_at,
        (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id AND o.paid_at IS NOT NULL) AS orders,
        (SELECT COALESCE(SUM(total_cents - refunded_cents), 0) FROM orders o WHERE o.user_id = u.id AND o.paid_at IS NOT NULL) AS spent_cents
      FROM users u WHERE u.email LIKE ? OR u.name LIKE ? ORDER BY u.created_at DESC LIMIT 300`, [q, q]);
  }));
  r.get('/api/admin/audit', A(() => all('SELECT id, email, action, detail, ip, created_at FROM audit_log ORDER BY id DESC LIMIT 200')));

  r.put('/api/admin/users/:id', A(async (req) => {
    const admin = requireAdmin(req);
    const b = await readJson(req);
    const id = Number(req.params.id);
    if (id === admin.id && (b.role === 'customer' || b.disabled)) throw bad("You can't remove your own admin access.");
    if (b.role) run('UPDATE users SET role = ? WHERE id = ?', [b.role === 'admin' ? 'admin' : 'customer', id]);
    if (b.disabled !== undefined) {
      run('UPDATE users SET disabled = ? WHERE id = ?', [b.disabled ? 1 : 0, id]);
      if (b.disabled) run('DELETE FROM sessions WHERE user_id = ?', id);
    }
    return { ok: true };
  }));

  // Reports ----------------------------------------------------------------------------------
  r.get('/api/admin/reports', A((req) => {
    const days = Math.min(365, Math.max(7, Number(req.query.days) || 30));
    const since = `-${days - 1} day`;
    const paid = all(`SELECT * FROM orders WHERE paid_at IS NOT NULL AND date(paid_at) >= date('now', ?)`, since);
    const byDay = {};
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400e3).toISOString().slice(0, 10);
      byDay[d] = { date: d, revenueCents: 0, orders: 0 };
    }
    const split = { filamentCents: 0, taxCents: 0, shippingCents: 0, feeCents: 0, refundedCents: 0 };
    for (const o of paid) {
      const d = o.paid_at.slice(0, 10);
      const p = parseJson(o.pricing, {});
      if (byDay[d]) { byDay[d].revenueCents += o.total_cents - o.refunded_cents; byDay[d].orders += 1; }
      split.filamentCents += p.filamentCents || 0;
      split.taxCents += p.taxCents || 0;
      split.shippingCents += p.shippingCents || 0;
      split.feeCents += p.feeCents || 0;
      split.refundedCents += o.refunded_cents;
    }
    const ids = paid.map((o) => o.id);
    const inList = ids.length ? ids.join(',') : '0';
    const topProducts = all(`SELECT title_en, title_ar, SUM(quantity) AS qty, SUM(filament_cents) AS filament_cents FROM order_items
      WHERE order_id IN (${inList}) AND kind = 'product' GROUP BY product_id ORDER BY qty DESC LIMIT 8`);
    const materials = all(`SELECT material, ROUND(SUM(weight_g)) AS grams, SUM(quantity) AS qty FROM order_items WHERE order_id IN (${inList}) GROUP BY material ORDER BY grams DESC`);
    const kinds = all(`SELECT kind, SUM(quantity) AS qty, SUM(filament_cents) AS filament_cents FROM order_items WHERE order_id IN (${inList}) GROUP BY kind`);
    const countries = all(`SELECT json_extract(address, '$.country') AS country, COUNT(*) AS orders, SUM(total_cents) AS cents FROM orders WHERE id IN (${inList}) GROUP BY country ORDER BY cents DESC LIMIT 8`);
    const gross = paid.reduce((s, o) => s + o.total_cents, 0);
    return {
      days,
      totals: { orders: paid.length, grossCents: gross, netCents: gross - split.refundedCents, avgOrderCents: paid.length ? Math.round(gross / paid.length) : 0 },
      byDay: Object.values(byDay), split, topProducts, materials, kinds, countries,
      printHours: Math.round((all(`SELECT stats FROM print_jobs WHERE status = 'printed' AND date(finished_at) >= date('now', ?)`, since)
        .reduce((s, j) => s + (parseJson(j.stats, {}).printTimeSec || 0), 0) / 3600) * 10) / 10,
    };
  }));
}
