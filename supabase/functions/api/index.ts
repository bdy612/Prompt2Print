// Prompt2Print cloud API — one edge function, routed by sub-path:
//   POST /api/quote        price lines for a destination (anyone)
//   POST /api/checkout     create an order from lines (signed in)
//   POST /api/pay          start / confirm a Tap payment (signed in)
//   POST /api/tap-webhook  Tap → order paid (verified by hashstring)
//   POST /api/designs      AI Create: create / status / regenerate (signed in)
//   GET  /api/preview?model=<id>   protected preview mesh (owner / catalog / admin)
//   POST /api/admin        admin actions (generate catalog model, order actions, printer test, seed)
//   GET  /api/health
import { serve, json, bad, notFound, forbidden, unauthorized, currentUser, requireUser, requireAdmin, serviceClient, audit, breathe, CORS, SUPABASE_URL } from '../_shared/http.js';
import { loadPricingContext, priceLine, quoteLines, currencyFor, convert } from '../_shared/quote.js';
import { checkPromptPolicy, DURABILITY_HINT, sizeHintMm } from '../_shared/policy.js';
import { processModel, storeModel } from '../_shared/pipeline.js';
import { getObject, putObject, mediaUrl } from '../_shared/store.js';
import { tripoCreate, tripoStatus } from '../_shared/tripo.js';
import { generateFromPrompt } from '../_shared/ai/procedural.js';
import { createTapCharge, retrieveTapCharge, tapChargePaid, tapChargeFailed, verifyTapWebhook, createTapRefund, amountToMinor } from '../_shared/tap.js';
import { placeOnBed } from '../_shared/mesh/core.js';
import { minScaleForWalls, maxScaleForBed } from '../_shared/mesh/analyze.js';

const env = (k) => Deno.env.get(k) || '';
const ORDER_FLOW = ['paid', 'in_queue', 'printing', 'printed', 'packed', 'shipped', 'delivered'];

// ------------------------------------------------------------------ lines → priced lines
async function resolveLines(db, ctx, rawLines, user) {
  if (!Array.isArray(rawLines) || !rawLines.length) throw bad('The cart is empty.', 'empty');
  if (rawLines.length > 20) throw bad('Too many lines.', 'too_many');
  const productIds = [...new Set(rawLines.filter((l) => l.productId).map((l) => Number(l.productId)))];
  const designIds = [...new Set(rawLines.filter((l) => l.designId).map((l) => String(l.designId)))];
  const [products, designs] = await Promise.all([
    productIds.length ? db.from('products').select('id,slug,name_en,name_ar,model_id,allowed_materials,min_scale,max_scale,images,active').in('id', productIds) : { data: [] },
    designIds.length ? db.from('designs').select('id,user_id,title_en,title_ar,model_id,thumb_url,status,prompt').in('id', designIds) : { data: [] },
  ]);
  const modelIds = [...new Set([...(products.data || []).map((p) => p.model_id), ...(designs.data || []).map((d) => d.model_id)].filter(Boolean))];
  const { data: models } = modelIds.length ? await db.from('models').select('id,analysis,thumb_url').in('id', modelIds) : { data: [] };
  const modelById = Object.fromEntries((models || []).map((m) => [m.id, m]));
  const out = [];
  for (const raw of rawLines) {
    let title, thumb, modelId, allowed, minScale, maxScale, productId = null, designId = null;
    if (raw.productId) {
      const p = (products.data || []).find((x) => x.id === Number(raw.productId));
      if (!p || !p.active) throw bad('One of the items is no longer available.', 'unavailable');
      title = { en: p.name_en, ar: p.name_ar }; thumb = (p.images || [])[0] || modelById[p.model_id]?.thumb_url || null;
      modelId = p.model_id; allowed = p.allowed_materials; minScale = Number(p.min_scale); maxScale = Number(p.max_scale); productId = p.id;
    } else if (raw.designId) {
      const d = (designs.data || []).find((x) => x.id === String(raw.designId));
      if (!d || d.status !== 'ready' || !d.model_id) throw bad('That design is not ready.', 'design_not_ready');
      if (!user || (d.user_id !== user.id && user.role !== 'admin')) throw forbidden('That design belongs to another account.');
      title = { en: d.title_en || d.prompt, ar: d.title_ar || d.prompt }; thumb = d.thumb_url; modelId = d.model_id; designId = d.id;
      const a = modelById[modelId]?.analysis;
      minScale = a ? minScaleForWalls(a, ctx.minWallMm) : 0.1;
      maxScale = a ? Math.min(ctx.maxModelMm / Math.max(...a.bbox.size, 1e-6), ...ctx.printers.map((p) => maxScaleForBed(a.bbox.size, p.bed))) : 20;
    } else throw bad('Each line needs a productId or a designId.', 'bad_line');
    const model = modelById[modelId];
    if (!model) throw bad('Model not found.', 'model_missing');
    const priced = priceLine(ctx, { analysis: model.analysis, material: raw.material, color: raw.color, scale: raw.scale ?? 1, infill: raw.infill ?? 35, quantity: raw.quantity ?? 1, allowedMaterials: allowed, minScale, maxScale });
    out.push({ ...priced, productId, designId, modelId, title, thumb, minScale: Math.round(minScale * 1000) / 1000, maxScale: Math.round(maxScale * 1000) / 1000, clientId: raw.id ?? null });
  }
  return out;
}

function publicLine(l) {
  const pr = l.printability;
  const failing = pr.checks.find((c) => c.status === 'fail');
  return {
    id: l.clientId, productId: l.productId, designId: l.designId, title: l.title, thumb: l.thumb,
    material: l.material, materialName: l.materialName, color: l.color, colorName: l.colorName, colorHex: l.colorHex,
    scale: l.scale, infill: l.infill, quantity: l.quantity, sizeMm: l.sizeMm, weightG: l.weightGrams,
    unitFilamentCents: l.unitFilamentCents, filamentCents: l.filamentCents,
    printable: pr.ok, reason: failing ? failing.detail : null, fragile: Boolean(pr.fragile), needsSupports: Boolean(pr.needsSupports),
    minScale: l.minScale, maxScale: Math.min(l.maxScale, pr.maxScale || l.maxScale),
  };
}

async function destinationFor(db, user, body) {
  if (body.addressId && user) {
    const { data: a } = await db.from('addresses').select('*').eq('id', Number(body.addressId)).eq('user_id', user.id).maybeSingle();
    if (a) return { country: a.country, region: a.region || '', address: a };
  }
  return { country: String(body.country || '').toUpperCase() || null, region: String(body.region || ''), address: null };
}

function quoteResponse(q) {
  return {
    lines: q.lines.map(publicLine),
    breakdown: { ...q.breakdown, taxRate: q.taxRate, zone: q.shipping ? { name: { en: q.shipping.zone.en, ar: q.shipping.zone.ar }, minDays: q.shipping.days[0], maxDays: q.shipping.days[1] } : null },
    display: q.display, printable: q.printable, shipsToDestination: q.shipsToDestination,
    problems: q.lines.filter((l) => !l.printability.ok).map((l) => `${l.title.en}: ${l.printability.checks.find((c) => c.status === 'fail')?.detail || 'not printable'}`),
  };
}

// ------------------------------------------------------------------ designs (AI Create)
async function runGeneration(db, design, ctx) {
  const update = async (fields) => { await db.from('designs').update(fields).eq('id', design.id); };
  try {
    const tripoKey = env('TRIPO_API_KEY');
    const sizeMm = sizeHintMm(design.prompt) || Number(ctx.defaultSizeMm || 100);
    let out, thumbBytes = null, thumbExt = 'png', provider = 'tripo';
    let useBuiltin = !tripoKey;
    if (!useBuiltin) {
      try {
        await update({ status: 'generating', progress: 5, provider: 'tripo' });
        const taskId = await tripoCreate(tripoKey, `${design.prompt}. ${DURABILITY_HINT}`);
        await update({ provider_task_id: String(taskId) });
        const deadline = Date.now() + 10 * 60e3;
        let st;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 4000));
          st = await tripoStatus(tripoKey, taskId);
          await update({ progress: Math.max(5, Math.min(90, st.progress)) });
          if (st.status === 'success') break;
          if (['failed', 'cancelled', 'banned', 'expired', 'unknown'].includes(st.status)) throw new Error(`Tripo could not generate this model (${st.status})`);
        }
        if (!st || st.status !== 'success' || !st.modelUrl) throw new Error('Tripo took too long to respond');
        const glb = new Uint8Array(await (await fetch(st.modelUrl)).arrayBuffer());
        if (st.imageUrl) {
          try { const r = await fetch(st.imageUrl); if (r.ok) { thumbBytes = new Uint8Array(await r.arrayBuffer()); thumbExt = /png/i.test(r.headers.get('content-type') || '') ? 'png' : 'jpg'; } } catch { /* no thumbnail */ }
        }
        out = await processModel({ bytes: glb, hint: '.glb' }, { repair: true, sizeMm, maxMm: ctx.maxModelMm, photo: thumbBytes ? null : { color: '#1E1F22', width: 480 } });
      } catch (err) {
        // Account problems at the AI service (no credits, bad key, outage): fall back to the built-in generator.
        if (!/credit|refused|too long|fetch|network|HTTP/i.test(err.message)) throw err;
        console.error(`[ai] Tripo unavailable for design ${design.id}: ${err.message}; using the built-in generator`);
        useBuiltin = true;
      }
    }
    if (useBuiltin) {
      provider = 'builtin';
      await update({ status: 'generating', progress: 20, provider: 'builtin' });
      const { mesh, info } = generateFromPrompt(design.prompt, { seed: design.seed });
      await breathe();
      out = await processModel({ mesh: placeOnBed(mesh) }, { repair: false, sizeMm: sizeHintMm(design.prompt) || null, maxMm: ctx.maxModelMm, photo: { color: '#1E1F22', width: 480 } });
      out.titleEn = info.titleEn; out.titleAr = info.titleAr;
    }
    const model = await storeModel(db, out, { source: 'ai', ownerId: design.user_id, thumbBytes, thumbExt });
    const title = design.prompt.length > 60 ? `${design.prompt.slice(0, 57)}…` : design.prompt;
    await update({ status: 'ready', progress: 100, model_id: model.id, thumb_url: model.thumbUrl, provider,
      title_en: out.titleEn || title.charAt(0).toUpperCase() + title.slice(1), title_ar: out.titleAr || title, error: null });
  } catch (err) {
    console.error(`[ai] design ${design.id} failed:`, err.message);
    await update({ status: 'failed', error: String(err.message).slice(0, 400) });
  }
}

async function designsRoute(req, body, db) {
  const user = await requireUser(req);
  const action = body.action || 'create';
  if (action === 'status') {
    const { data } = await db.from('designs').select('*').eq('id', String(body.id)).eq('user_id', user.id).maybeSingle();
    if (!data) throw notFound();
    return { design: data };
  }
  let prompt, parentId = null, seed;
  if (action === 'regenerate') {
    const { data: parent } = await db.from('designs').select('*').eq('id', String(body.id)).eq('user_id', user.id).maybeSingle();
    if (!parent) throw notFound();
    prompt = parent.prompt; parentId = parent.id; seed = (parent.seed + 1) % 2147483647;
  } else {
    prompt = String(body.prompt || '').trim().replace(/\s+/g, ' ').slice(0, 600);
    if (prompt.length < 3) throw bad('Describe the object in a few words.', 'empty_prompt');
    seed = Number.isInteger(body.seed) ? body.seed : Math.floor(Math.random() * 2147483647);
    parentId = body.parentId ? String(body.parentId) : null;
  }
  checkPromptPolicy(prompt, body.locale || user.locale);
  // Fair use: at most N generations per hour per account.
  const { data: limitRow } = await db.from('settings').select('value').eq('key', 'ai_hourly_limit').maybeSingle();
  const limit = Number(limitRow?.value ?? 30);
  const since = new Date(Date.now() - 3600e3).toISOString();
  const { count } = await db.from('designs').select('id', { count: 'exact', head: true }).eq('user_id', user.id).gte('created_at', since);
  if ((count || 0) >= limit) throw bad('You have made many designs in the last hour. Please try again a bit later.', 'rate_limited');
  const { data: design, error } = await db.from('designs').insert({ user_id: user.id, prompt, seed, parent_id: parentId, status: 'queued', progress: 0 }).select('*').single();
  if (error) throw new Error(error.message);
  const { data: sizeRow } = await db.from('settings').select('value').eq('key', 'ai_default_size_mm').maybeSingle();
  const ctx = { maxModelMm: 250, defaultSizeMm: Number(sizeRow?.value ?? 100) };
  EdgeRuntime.waitUntil(runGeneration(db, design, ctx));
  return { design };
}

// ------------------------------------------------------------------ orders & payments
async function createOrder(db, user, body) {
  const ctx = await loadPricingContext(db);
  const dest = await destinationFor(db, user, body);
  if (!dest.address) throw bad('Choose a delivery address.', 'address_required');
  const lines = await resolveLines(db, ctx, body.lines, user);
  const q = quoteLines(ctx, lines, dest);
  if (!q.shipsToDestination) throw bad('We do not ship to that country yet.', 'no_shipping');
  if (!q.printable) throw bad('One of the items cannot be printed at that size.', 'not_printable');
  const { data: numberRow } = await db.rpc('next_order_number');
  const number = typeof numberRow === 'string' ? numberRow : `P2P-${Date.now()}`;
  const a = dest.address;
  const { data: order, error } = await db.from('orders').insert({
    number, user_id: user.id, status: 'pending_payment', country: dest.country, region: dest.region,
    address: { fullName: a.full_name, phone: a.phone, line1: a.line1, line2: a.line2, city: a.city, region: a.region, postalCode: a.postal_code, country: a.country },
    pricing: { ...q.breakdown, taxRate: q.taxRate, shipping: q.shipping }, total_cents: q.breakdown.totalCents,
    display_currency: q.display.currency, fx_rate: q.display.rate, charged_amount: q.display.total,
  }).select('*').single();
  if (error) throw new Error(error.message);
  const items = lines.map((l) => ({
    order_id: order.id, product_id: l.productId, design_id: l.designId, model_id: l.modelId, title_en: l.title.en, title_ar: l.title.ar,
    material: l.material, color: l.color, scale: l.scale, infill: l.infill, quantity: l.quantity, size_mm: l.sizeMm, weight_g: l.unitWeightGrams,
    print_time_sec: 0, filament_cents: l.filamentCents, thumb_url: l.thumb,
  }));
  const { error: e2 } = await db.from('order_items').insert(items);
  if (e2) throw new Error(e2.message);
  await db.from('order_events').insert({ order_id: order.id, status: 'pending_payment', detail: 'Order placed' });
  return order;
}

async function markPaid(db, order, payment) {
  if (order.status !== 'pending_payment') return order;
  const { data: updated } = await db.from('orders').update({ status: 'paid', paid_at: new Date().toISOString(), payment }).eq('id', order.id).eq('status', 'pending_payment').select('*').maybeSingle();
  if (!updated) return order;
  await db.from('order_events').insert({ order_id: order.id, status: 'paid', detail: `Paid via ${payment.provider}` });
  const { data: items } = await db.from('order_items').select('id,quantity,product_id').eq('order_id', order.id);
  const jobs = [];
  for (const it of items || []) for (let c = 1; c <= it.quantity; c++) jobs.push({ order_id: order.id, order_item_id: it.id, copy_index: c, status: 'queued' });
  if (jobs.length) await db.from('print_jobs').insert(jobs);
  for (const it of items || []) if (it.product_id) await db.rpc('bump_sold', { pid: it.product_id, n: it.quantity }).then(() => {}, () => {});
  await db.from('orders').update({ status: 'in_queue' }).eq('id', order.id);
  await db.from('order_events').insert({ order_id: order.id, status: 'in_queue', detail: 'Waiting for a printer' });
  return { ...updated, status: 'in_queue' };
}

async function payRoute(req, body, db) {
  const user = await requireUser(req);
  const { data: order } = await db.from('orders').select('*').eq('number', String(body.orderNumber || '')).eq('user_id', user.id).maybeSingle();
  if (!order) throw notFound('Order not found.');
  const secret = env('TAP_SECRET_KEY');
  if (!secret) throw bad("Payments aren't set up yet, so this order can't be paid. Please try again later.", 'payments_unconfigured');
  if (body.confirm) {
    if (order.status !== 'pending_payment') return { order };
    const chargeId = String(body.tapId || order.payment?.chargeId || '');
    if (!chargeId) throw bad('No payment to confirm.', 'no_charge');
    const charge = await retrieveTapCharge(chargeId, secret);
    if (tapChargePaid(charge)) {
      const paid = Number(charge.amount), cur = String(charge.currency).toUpperCase();
      if (cur !== order.display_currency || Math.abs(paid - Number(order.charged_amount)) > 0.011) {
        await db.from('order_events').insert({ order_id: order.id, status: 'pending_payment', detail: `Unexpected payment ${paid} ${cur}` });
        throw bad('The payment amount does not match the order. Please contact support.', 'amount_mismatch');
      }
      return { order: await markPaid(db, order, { provider: 'tap', chargeId, amount: paid, currency: cur }) };
    }
    if (tapChargeFailed(charge)) throw bad('The payment was not completed. You can try again.', 'payment_failed');
    return { order, pending: true };
  }
  if (order.status !== 'pending_payment') throw bad('This order is already paid.', 'already_paid');
  const returnUrl = String(body.returnUrl || '');
  if (!/^https?:\/\//.test(returnUrl)) throw bad('A return URL is required.', 'bad_return_url');
  const charge = await createTapCharge({
    order: { number: order.number }, amountMinor: amountToMinor(Number(order.charged_amount), order.display_currency), currency: order.display_currency,
    customer: { name: order.address?.fullName || user.name, email: user.email, phone: order.address?.phone },
    redirectUrl: returnUrl, postUrl: `${SUPABASE_URL}/functions/v1/api/tap-webhook`, secretKey: secret,
    description: `Prompt2Print order ${order.number}`, metadata: { order_id: order.id },
  });
  await db.from('orders').update({ payment: { provider: 'tap', chargeId: charge.chargeId, status: 'initiated' } }).eq('id', order.id);
  return { provider: 'tap', url: charge.redirectUrl, chargeId: charge.chargeId };
}

async function tapWebhook(req, body, db) {
  const secret = env('TAP_SECRET_KEY');
  if (!secret) return json({ ok: false }, 503);
  const hash = req.headers.get('hashstring') || '';
  if (!verifyTapWebhook(body, hash, secret)) return json({ error: { message: 'Bad signature', code: 'bad_signature' } }, 401);
  const number = body?.metadata?.order_number || body?.reference?.order;
  if (!number) return { ok: true };
  const { data: order } = await db.from('orders').select('*').eq('number', String(number)).maybeSingle();
  if (!order) return { ok: true };
  if (tapChargePaid(body)) {
    const paid = Number(body.amount), cur = String(body.currency).toUpperCase();
    if (cur === order.display_currency && Math.abs(paid - Number(order.charged_amount)) <= 0.011) await markPaid(db, order, { provider: 'tap', chargeId: body.id, amount: paid, currency: cur });
    else await db.from('order_events').insert({ order_id: order.id, status: order.status, detail: `Webhook with unexpected amount ${paid} ${cur}` });
  }
  return { ok: true };
}

// ------------------------------------------------------------------ admin
async function adminRoute(req, body, db) {
  const admin = await requireAdmin(req);
  const action = String(body.action || '');
  if (action === 'generate' || action === 'seed-product') {
    // Catalog model with the built-in generator (+ product row for seed-product).
    const prompt = String(body.prompt || '').trim();
    if (!prompt) throw bad('Prompt required.');
    const { mesh, info } = generateFromPrompt(prompt, { seed: Number(body.seed) || 1 });
    await breathe();
    const hex = body.colorHex || '#8A8F96';
    const out = await processModel({ mesh: placeOnBed(mesh) }, { repair: false, maxMm: 250, photo: { color: hex, width: 640 } });
    const model = await storeModel(db, out, { source: 'catalog' });
    let product = null;
    if (action === 'seed-product' && body.product) {
      const p = body.product;
      const slug = String(p.slug || p.nameEn).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const { data: cat } = await db.from('categories').select('id').eq('slug', p.category).maybeSingle();
      const row = {
        slug, category_id: cat?.id || null, model_id: model.id, name_en: p.nameEn, name_ar: p.nameAr, desc_en: p.descEn || '', desc_ar: p.descAr || '',
        default_material: p.material || 'ABS', default_color: p.color || 'grey', allowed_materials: ['ABS', 'ASA'],
        default_scale: 1, min_scale: Math.round(minScaleForWalls(model.analysis, 2) * 1000) / 1000, max_scale: Math.round(Math.min(250 / Math.max(...model.analysis.bbox.size), maxScaleForBed(model.analysis.bbox.size, { x: 256, y: 256, z: 256 })) * 1000) / 1000,
        default_infill: 35, images: [model.thumbUrl], tags: p.tags || '', featured: Boolean(p.featured), active: true,
      };
      const { data, error } = await db.from('products').upsert(row, { onConflict: 'slug' }).select('*').single();
      if (error) throw new Error(error.message);
      product = data;
    }
    await audit(db, req, admin, 'admin.generate', { prompt });
    return { model: { id: model.id, thumbUrl: model.thumbUrl, analysis: model.analysis, titleEn: info.titleEn, titleAr: info.titleAr }, product };
  }
  if (action === 'order') {
    const { data: order } = await db.from('orders').select('*').eq('id', String(body.id)).maybeSingle();
    if (!order) throw notFound('Order not found.');
    const act = String(body.do || '');
    if (act === 'advance') {
      const i = ORDER_FLOW.indexOf(order.status);
      if (i < 0 || i === ORDER_FLOW.length - 1) throw bad('This order cannot be advanced.', 'bad_state');
      const next = ORDER_FLOW[i + 1];
      const patch = { status: next };
      if (next === 'shipped' && body.tracking) patch.tracking = { carrier: String(body.tracking.carrier || ''), number: String(body.tracking.number || ''), url: String(body.tracking.url || '') };
      await db.from('orders').update(patch).eq('id', order.id);
      await db.from('order_events').insert({ order_id: order.id, status: next, detail: body.note ? String(body.note) : '' });
      await audit(db, req, admin, 'order.advance', { number: order.number, to: next });
      return { ok: true, status: next };
    }
    if (act === 'cancel') {
      if (['shipped', 'delivered', 'refunded', 'cancelled'].includes(order.status)) throw bad('This order cannot be cancelled.', 'bad_state');
      await db.from('print_jobs').update({ status: 'cancelled' }).eq('order_id', order.id).in('status', ['queued', 'slicing', 'paused']);
      await db.from('orders').update({ status: 'cancelled' }).eq('id', order.id);
      await db.from('order_events').insert({ order_id: order.id, status: 'cancelled', detail: String(body.note || '') });
      await audit(db, req, admin, 'order.cancel', { number: order.number });
      return { ok: true, status: 'cancelled' };
    }
    if (act === 'refund') {
      const secret = env('TAP_SECRET_KEY');
      if (order.payment?.provider !== 'tap' || !order.payment?.chargeId) throw bad('No card payment to refund.', 'no_payment');
      if (!secret) throw bad('Payments are not configured.', 'payments_unconfigured');
      const amount = Number(body.amount || order.charged_amount);
      await createTapRefund({ chargeId: order.payment.chargeId, amountMinor: amountToMinor(amount, order.display_currency), currency: order.display_currency, secretKey: secret, reason: String(body.reason || 'requested_by_customer') });
      const refundedCents = Math.round((amount / Number(order.fx_rate || 1)) * 100);
      await db.from('orders').update({ status: 'refunded', refunded_cents: order.refunded_cents + refundedCents }).eq('id', order.id);
      await db.from('order_events').insert({ order_id: order.id, status: 'refunded', detail: `${amount} ${order.display_currency}` });
      await audit(db, req, admin, 'order.refund', { number: order.number, amount });
      return { ok: true, status: 'refunded' };
    }
    throw bad('Unknown order action.');
  }
  if (action === 'printer-test') {
    await db.from('settings').upsert({ key: 'agent:test_printer', value: { id: Number(body.id), at: new Date().toISOString() } });
    return { ok: true, message: 'Test requested; the print agent will report the result on the printer card.' };
  }
  if (action === 'audit') { await audit(db, req, admin, String(body.what || 'admin.action'), body.detail || {}); return { ok: true }; }
  throw bad('Unknown admin action.');
}

// ------------------------------------------------------------------ live rates from the internet
// Currency rates: open.er-api.com (free, daily). Tax rates: the maintained worldwide VAT/GST/sales-tax
// dataset of the open-source "sales-tax" project. Runs daily (pg_cron) and on demand by an admin.
const TAX_SOURCE = 'https://raw.githubusercontent.com/valeriansaliou/node-sales-tax/master/res/sales_tax_rates.json';
const FX_SOURCE = 'https://open.er-api.com/v6/latest/SAR';

async function refreshRates(db, { force = false } = {}) {
  const { data: last } = await db.from('settings').select('value').eq('key', 'rates_updated_at').maybeSingle();
  if (!force && last?.value && Date.now() - new Date(last.value).getTime() < 3600e3) return { skipped: true, updatedAt: last.value };
  const report = { currencies: 0, taxes: 0, errors: [] };
  try {
    const fx = await (await fetch(FX_SOURCE)).json();
    if (fx?.result === 'success' && fx.rates) {
      const { data: rows } = await db.from('currencies').select('code');
      for (const r of rows || []) {
        const rate = fx.rates[r.code];
        if (rate > 0) { await db.from('currencies').update({ rate: Math.round(rate * 1e6) / 1e6 }).eq('code', r.code); report.currencies++; }
      }
      await db.from('settings').upsert({ key: 'fx_source', value: { name: 'open.er-api.com', base: 'SAR', time: fx.time_last_update_utc || null } });
    } else report.errors.push('currency source unavailable');
  } catch (e) { report.errors.push(`currencies: ${e.message}`); }
  try {
    const tax = await (await fetch(TAX_SOURCE)).json();
    const upserts = [];
    for (const [country, info] of Object.entries(tax)) {
      if (!/^[A-Z]{2}$/.test(country) || typeof info !== 'object') continue;
      const rate = Math.round(Number(info.rate || 0) * 10000) / 100;
      upserts.push({ country, region: '*', rate, label: String(info.type || 'tax').toUpperCase() === 'NONE' ? '' : String(info.type || 'tax').toUpperCase() });
      for (const [state, st] of Object.entries(info.states || {})) {
        upserts.push({ country, region: state, rate: Math.round(Number(st.rate || 0) * 10000) / 100, label: String(st.type || info.type || 'tax').toUpperCase() });
      }
    }
    // The same dataset says which currency each country uses: keep country_currency complete and
    // make sure every currency it needs exists (rate from the FX feed, 0 decimals for JPY/KRW-style).
    try {
      const fx = await (await fetch(FX_SOURCE)).json();
      if (fx?.rates) {
        const ZERO_DEC = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'HUF', 'IDR', 'TWD', 'UGX', 'PYG', 'XAF', 'XOF', 'RWF']);
        const THREE_DEC = new Set(['KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'LYD', 'TND']);
        const { data: have } = await db.from('currencies').select('code');
        const known = new Set((have || []).map((c) => c.code));
        const ccRows = [];
        for (const [country, info] of Object.entries(tax)) {
          const cur = String(info?.currency || '').toUpperCase();
          if (!/^[A-Z]{2}$/.test(country) || !/^[A-Z]{3}$/.test(cur) || !(fx.rates[cur] > 0)) continue;
          if (!known.has(cur)) {
            await db.from('currencies').upsert({ code: cur, name: cur, rate: Math.round(fx.rates[cur] * 1e6) / 1e6, decimals: ZERO_DEC.has(cur) ? 0 : THREE_DEC.has(cur) ? 3 : 2, sort: 100 });
            known.add(cur);
          }
          ccRows.push({ country, currency: cur });
        }
        for (let i = 0; i < ccRows.length; i += 200) await db.from('country_currency').upsert(ccRows.slice(i, i + 200), { onConflict: 'country' });
      }
    } catch (e) { report.errors.push(`country currencies: ${e.message}`); }
    if (upserts.length > 50) {
      for (let i = 0; i < upserts.length; i += 200) {
        const { error } = await db.from('tax_rates').upsert(upserts.slice(i, i + 200), { onConflict: 'country,region' });
        if (error) throw new Error(error.message);
      }
      report.taxes = upserts.length;
      await db.from('settings').upsert({ key: 'tax_source', value: { name: 'sales-tax dataset (GitHub)', url: TAX_SOURCE } });
    } else report.errors.push('tax source returned too little data');
  } catch (e) { report.errors.push(`taxes: ${e.message}`); }
  const now = new Date().toISOString();
  await db.from('settings').upsert({ key: 'rates_updated_at', value: now });
  return { ...report, updatedAt: now };
}

// ------------------------------------------------------------------ router
serve(async (req, body) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^.*\/api\/?/, '').replace(/\/+$/, '');
  const db = serviceClient();
  switch (route) {
    case 'health': return { ok: true, name: 'Prompt2Print', version: '2.0.0' };
    case 'quote': {
      const user = await currentUser(req);
      const ctx = await loadPricingContext(db);
      const dest = await destinationFor(db, user, body);
      const lines = await resolveLines(db, ctx, body.lines, user);
      return quoteResponse(quoteLines(ctx, lines, dest));
    }
    case 'checkout': {
      const user = await requireUser(req);
      const order = await createOrder(db, user, body);
      await audit(db, req, user, 'order.create', { number: order.number });
      return { order };
    }
    case 'pay': return payRoute(req, body, db);
    case 'tap-webhook': return tapWebhook(req, body, db);
    case 'designs': return designsRoute(req, body, db);
    case 'preview': {
      const id = url.searchParams.get('model') || '';
      if (!/^[0-9a-f-]{36}$/.test(id)) throw bad('Bad model id.');
      const user = await currentUser(req);
      const { data: m } = await db.from('models').select('id,source,owner_id,preview_path').eq('id', id).maybeSingle();
      if (!m) throw notFound();
      const allowed = m.source === 'catalog' || (user && (user.role === 'admin' || m.owner_id === user.id));
      if (!allowed) throw user ? forbidden() : unauthorized();
      const bytes = await getObject(db, 'models', m.preview_path);
      return new Response(bytes, { headers: { ...CORS, 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, no-store' } });
    }
    case 'admin': return adminRoute(req, body, db);
    case 'rates-refresh': {
      const user = await currentUser(req);
      return refreshRates(db, { force: user?.role === 'admin' || body.force === true });
    }
    default: throw notFound('Unknown route.');
  }
});
