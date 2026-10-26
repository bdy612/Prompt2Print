// Data layer. The pages still call `api('/api/...')` as before; every call is mapped here to the
// Supabase backend: tables under Row Level Security for reads/writes, Edge Functions for anything
// that needs secrets or server-side truth (orders, payments, AI generation, model files).
import { sb, FUNCTIONS_URL, authHeaders, mediaUrl } from './supabase.js';
import { COUNTRIES } from './countries.js';
import * as pricing from './pricing.js';
import { cartLines, addLine, updateLine, removeLine, clearCart, cartCount } from './cart-store.js';
import { loadSavedDestination } from './state.js';

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || body?.message || `Request failed (${status})`);
    this.status = status;
    this.code = body?.error?.code || body?.code;
    this.body = body;
  }
}
const bad = (message, code = 'bad_request', status = 400) => new ApiError(status, { error: { message, code } });
const notFound = (message = 'Not found') => new ApiError(404, { error: { message, code: 'not_found' } });
const unauthorized = () => new ApiError(401, { error: { message: 'Please sign in.', code: 'unauthorized' } });

export const qs = (obj) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

// Supabase query result → data or ApiError.
function unwrap({ data, error }, status = 400) {
  if (error) throw new ApiError(error.status || status, { error: { message: error.message, code: error.code } });
  return data;
}

// Edge Function call with JSON in/out.
export async function callFn(name, body, { method = 'POST' } = {}) {
  const res = await fetch(`${FUNCTIONS_URL}/${name}`, {
    method, headers: { ...(await authHeaders()), 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: { message: text.slice(0, 200) } }; }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

// ---------------------------------------------------------------- session + profile
let sessionUser = null;      // { id, email, name, role, locale }
export function currentUser() { return sessionUser; }

export async function loadSessionUser({ fresh = false } = {}) {
  const { data } = await sb.auth.getSession();
  const u = data.session?.user;
  if (!u) { sessionUser = null; return null; }
  const cacheKey = `p2p_profile:${u.id}`;
  if (!fresh) {
    try { const c = JSON.parse(localStorage.getItem(cacheKey) || 'null'); if (c && Date.now() - c.at < 10 * 60e3) { sessionUser = c.user; refreshProfile(u, cacheKey); return sessionUser; } } catch { /* ignore */ }
  }
  sessionUser = await fetchProfile(u, cacheKey);
  return sessionUser;
}
async function fetchProfile(u, cacheKey) {
  const { data: p } = await sb.from('profiles').select('id,email,name,role,locale,disabled').eq('id', u.id).maybeSingle();
  const user = { id: u.id, email: p?.email || u.email, name: p?.name || u.user_metadata?.name || u.email.split('@')[0], role: p?.role || 'customer', locale: p?.locale || u.user_metadata?.locale || 'en', disabled: p?.disabled || false };
  try { localStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), user })); } catch { /* ignore */ }
  return user;
}
function refreshProfile(u, cacheKey) { fetchProfile(u, cacheKey).then((user) => { sessionUser = user; }).catch(() => {}); }

export async function signOut() {
  await sb.auth.signOut();
  sessionUser = null;
}

// ---------------------------------------------------------------- reference data (bootstrap)
const BOOT_KEY = 'p2p_boot_v2';
let ref = null;      // raw reference data from the tables
let refAt = 0;

async function fetchReference() {
  const [settings, currencies, cc, taxes, zones, categories, materials] = await Promise.all([
    sb.from('settings').select('key,value'),
    sb.from('currencies').select('code,name,rate,decimals,sort').order('sort'),
    sb.from('country_currency').select('country,currency'),
    sb.from('tax_rates').select('id,country,region,rate,label'),
    sb.from('shipping_zones').select('id,name_en,name_ar,countries,base_cents,per_kg_cents,volumetric_divisor,min_days,max_days,active,sort').order('sort'),
    sb.from('categories').select('id,slug,name_en,name_ar,sort').order('sort'),
    sb.from('materials').select('*').order('sort'),
  ]);
  const s = Object.fromEntries((unwrap(settings) || []).map((r) => [r.key, r.value]));
  return {
    settings: s, currencies: unwrap(currencies) || [], countryCurrency: Object.fromEntries((unwrap(cc) || []).map((r) => [r.country, r.currency])),
    taxRates: unwrap(taxes) || [], zones: unwrap(zones) || [], categories: unwrap(categories) || [], materials: unwrap(materials) || [],
  };
}

async function reference({ fresh = false } = {}) {
  if (ref && Date.now() - refAt < 60e3 && !fresh) return ref;
  if (!ref && !fresh) {
    try { const c = JSON.parse(localStorage.getItem(BOOT_KEY) || 'null'); if (c && Date.now() - c.at < 10 * 60e3) { ref = c.ref; refAt = c.at; fetchReference().then(saveRef).catch(() => {}); return ref; } } catch { /* ignore */ }
  }
  saveRef(await fetchReference());
  return ref;
}
function saveRef(r) {
  ref = r; refAt = Date.now();
  try { localStorage.setItem(BOOT_KEY, JSON.stringify({ at: refAt, ref: r })); } catch { /* ignore */ }
}

function pricingCtx(r) {
  const materials = {};
  for (const m of r.materials) materials[m.code] = m;
  return {
    materials, taxRates: r.taxRates, zones: r.zones, feeTiers: r.settings.fee_tiers || pricing.DEFAULT_FEE_TIERS,
    wallMm: Number(r.settings.wall_thickness_mm || 2.1), infillRange: r.settings.infill_range || [30, 40],
    maxModelMm: Number(r.settings.max_model_mm || 250), minWallMm: Number(r.settings.min_wall_mm || 2),
    currencies: r.currencies, countryCurrency: r.countryCurrency, fallbackCurrency: r.settings.fallback_currency || 'USD', defaultCountry: r.settings.default_country || 'SA',
  };
}

function materialsPublic(r) {
  return r.materials.filter((m) => m.active !== false).map((m) => ({
    code: m.code, name: { en: m.name_en, ar: m.name_ar }, desc: { en: m.desc_en, ar: m.desc_ar }, pricePerGram: Number(m.price_per_gram), density: Number(m.density),
    process: m.process, maxTempC: m.max_temp_c || (m.code === 'ASA' ? 100 : 85),
    colors: (m.colors || []).filter((c) => c.in_stock !== false).map((c) => ({ code: c.code, name: { en: c.name_en, ar: c.name_ar }, hex: c.hex })),
  }));
}

async function destinationFor(src = {}) {
  if (sessionUser && src.addressId) {
    const a = (await addressList()).find((x) => x.id === Number(src.addressId));
    if (a) return { country: a.country, region: a.region || '', addressId: a.id };
  }
  if (src.country) return { country: String(src.country).toUpperCase().slice(0, 2), region: String(src.region || '').slice(0, 40) };
  const saved = loadSavedDestination();
  if (saved?.country) return { country: saved.country, region: saved.region || '', addressId: saved.addressId };
  const r = await reference();
  return { country: r.settings.default_country || 'SA', region: '' };
}

async function bootstrap(q) {
  const r = await reference();
  const dest = await destinationFor(q);
  const ctx = pricingCtx(r);
  const disp = pricing.currencyFor(ctx, dest.country);
  const cats = await categoriesPublic(r);
  return {
    user: sessionUser,
    storeName: r.settings.store_name || 'Prompt2Print',
    currency: 'SAR',
    feeTiers: ctx.feeTiers,
    defaultCountry: ctx.defaultCountry,
    destination: dest,
    display: { currency: disp.code, rate: Number(disp.rate), decimals: disp.decimals },
    countries: COUNTRIES,
    materials: materialsPublic(r),
    categories: cats,
    currencies: r.currencies,
    infillRange: ctx.infillRange,
    maxModelMm: ctx.maxModelMm,
    cartCount: cartCount(),
    ai: { provider: r.settings.ai_provider || 'auto' },
    payments: { provider: r.settings.payment_provider || 'tap' },
    demo: false,
  };
}

// ---------------------------------------------------------------- catalog
let catalog = null;    // active products with model analysis
let catalogAt = 0;
let ratings = null;    // product_id -> { avg, count, dist }
const PRODUCT_COLS = 'id,slug,category_id,model_id,name_en,name_ar,desc_en,desc_ar,default_material,default_color,allowed_materials,default_scale,min_scale,max_scale,default_infill,images,tags,featured,sold_count,created_at,models(analysis)';

async function loadCatalog({ fresh = false } = {}) {
  if (catalog && Date.now() - catalogAt < 60e3 && !fresh) return catalog;
  const [prods, revs] = await Promise.all([
    sb.from('products').select(PRODUCT_COLS).eq('active', true).order('featured', { ascending: false }).order('sold_count', { ascending: false }),
    sb.from('reviews').select('product_id,rating'),
  ]);
  catalog = (unwrap(prods) || []).map((p) => ({ ...p, images: (p.images || []).map(mediaUrl), allowed_materials: p.allowed_materials || ['ABS', 'ASA'], analysis: p.models?.analysis || null }));
  catalogAt = Date.now();
  ratings = {};
  for (const r of unwrap(revs) || []) {
    const x = ratings[r.product_id] || (ratings[r.product_id] = { sum: 0, count: 0, dist: {} });
    x.sum += r.rating; x.count += 1; x.dist[r.rating] = (x.dist[r.rating] || 0) + 1;
  }
  return catalog;
}
const ratingOf = (id) => { const x = ratings?.[id]; return x ? { rating: Math.round((x.sum / x.count) * 10) / 10, count: x.count, dist: x.dist } : { rating: 0, count: 0, dist: {} }; };

function productBase(p) {
  const r = ratingOf(p.id);
  return {
    id: p.id, slug: p.slug, modelId: p.model_id, name: { en: p.name_en, ar: p.name_ar }, images: p.images, rating: r.rating, ratingCount: r.count,
    soldCount: p.sold_count, featured: Boolean(p.featured), categoryId: p.category_id,
  };
}
function defaultLine(p) {
  return { analysis: p.analysis, material: p.default_material, color: p.default_color, scale: Number(p.default_scale), infill: p.default_infill, quantity: 1, allowedMaterials: p.allowed_materials, minScale: Number(p.min_scale), maxScale: Number(p.max_scale) };
}
function productCard(p, ctx, dest) {
  let price = null;
  try {
    if (p.analysis) {
      const q = pricing.quoteLines(ctx, [pricing.priceLine(ctx, defaultLine(p))], dest);
      price = { totalCents: q.breakdown.totalCents, shipsToDestination: q.shipsToDestination, display: q.display, fragile: Boolean(q.lines[0].printability.fragile) };
    }
  } catch { /* misconfigured product: no price */ }
  return { ...productBase(p), price };
}

async function categoriesPublic(r) {
  const list = await loadCatalog();
  return r.categories.map((c) => {
    const inCat = list.filter((p) => p.category_id === c.id);
    return { id: c.id, slug: c.slug, name: { en: c.name_en, ar: c.name_ar }, count: inCat.length, cover: inCat[0]?.images?.[0] || null };
  });
}

async function products(q) {
  const [r, list] = await Promise.all([reference(), loadCatalog()]);
  const ctx = pricingCtx(r);
  const dest = await destinationFor(q);
  let rows = list;
  if (q.category) { const c = r.categories.find((x) => x.slug === q.category); rows = rows.filter((p) => p.category_id === c?.id); }
  if (q.featured) rows = rows.filter((p) => p.featured);
  if (q.q) {
    const terms = String(q.q).trim().toLowerCase().split(/\s+/).slice(0, 6);
    const hay = (p) => [p.name_en, p.name_ar, p.desc_en, p.desc_ar, p.tags, r.categories.find((c) => c.id === p.category_id)?.name_en, r.categories.find((c) => c.id === p.category_id)?.name_ar].join(' ').toLowerCase();
    rows = rows.filter((p) => { const h = hay(p); return terms.every((t) => h.includes(t)); });
  }
  let items = rows.map((p) => ({ ...productCard(p, ctx, dest), _created: p.created_at }));
  const price = (x) => x.price?.totalCents ?? Infinity;
  const sorters = {
    price_asc: (a, b) => price(a) - price(b), price_desc: (a, b) => price(b) - price(a),
    rating: (a, b) => b.rating - a.rating || b.ratingCount - a.ratingCount, newest: (a, b) => (a._created < b._created ? 1 : -1),
    bestselling: (a, b) => b.soldCount - a.soldCount, featured: (a, b) => Number(b.featured) - Number(a.featured) || b.soldCount - a.soldCount,
  };
  items.sort(sorters[q.sort] || sorters.featured);
  const limit = Math.min(60, Number(q.limit) || 24);
  const page = Math.max(1, Number(q.page) || 1);
  const total = items.length;
  items = items.slice((page - 1) * limit, page * limit).map(({ _created, ...rest }) => rest);
  return { items, total, page, pages: Math.ceil(total / limit), destination: dest };
}

async function productDetail(slug, q) {
  const [r, list] = await Promise.all([reference(), loadCatalog()]);
  const p = list.find((x) => x.slug === slug);
  if (!p) throw notFound('This product is not available.');
  const ctx = pricingCtx(r);
  const dest = await destinationFor(q);
  const cat = r.categories.find((c) => c.id === p.category_id);
  const related = list.filter((x) => x.category_id === p.category_id && x.id !== p.id).slice(0, 6).map((x) => productCard(x, ctx, dest));
  let inWishlist = false;
  if (sessionUser) {
    const { data } = await sb.from('wishlist').select('product_id').eq('user_id', sessionUser.id).eq('product_id', p.id).maybeSingle();
    inWishlist = Boolean(data);
  }
  const rt = ratingOf(p.id);
  return {
    ...productBase(p), description: { en: p.desc_en, ar: p.desc_ar }, category: cat ? { slug: cat.slug, name: { en: cat.name_en, ar: cat.name_ar } } : null,
    modelId: p.model_id, analysis: pricing.publicAnalysis(p.analysis),
    defaults: { material: p.default_material, color: p.default_color, scale: Number(p.default_scale), infill: p.default_infill },
    allowedMaterials: p.allowed_materials, minScale: Number(p.min_scale), maxScale: Number(p.max_scale), inWishlist, ratingDistribution: rt.dist, related, destination: dest,
  };
}

async function reviewsOf(slug) {
  const list = await loadCatalog();
  const p = list.find((x) => x.slug === slug);
  if (!p) throw notFound();
  const rows = unwrap(await sb.from('reviews').select('id,rating,text,created_at,user_id,profiles(name,locale)').eq('product_id', p.id).order('created_at', { ascending: false }).limit(100)) || [];
  return rows.map((x) => ({ id: x.id, rating: x.rating, title: '', body: x.text, locale: x.profiles?.locale || 'en', verified: false, author_name: x.profiles?.name || (x.user_id === sessionUser?.id ? sessionUser.name : 'Customer'), created_at: x.created_at }));
}
async function postReview(slug, b) {
  if (!sessionUser) throw unauthorized();
  const list = await loadCatalog();
  const p = list.find((x) => x.slug === slug);
  if (!p) throw notFound();
  const rating = Math.round(Number(b.rating));
  if (!(rating >= 1 && rating <= 5)) throw bad('Choose a rating from 1 to 5 stars.');
  const text = `${b.title ? `${String(b.title).trim()} — ` : ''}${String(b.body || '').trim()}`.slice(0, 2000);
  if (String(b.body || '').trim().length < 5) throw bad('Write a few words about the item.');
  unwrap(await sb.from('reviews').insert({ product_id: p.id, user_id: sessionUser.id, rating, text }));
  catalogAt = 0;
  return { ok: true };
}

// ---------------------------------------------------------------- designs
const designDTO = (d) => ({
  id: d.id, prompt: d.prompt, seed: d.seed, parentId: d.parent_id, status: d.status === 'queued' ? 'generating' : d.status, progress: d.progress,
  provider: d.provider, title: { en: d.title_en, ar: d.title_ar }, thumb: mediaUrl(d.thumb_url), error: d.error, modelId: d.model_id,
  analysis: d.models?.analysis ? pricing.publicAnalysis(d.models.analysis) : null, _analysis: d.models?.analysis || null, createdAt: d.created_at,
});
const DESIGN_COLS = 'id,prompt,seed,parent_id,status,progress,provider,title_en,title_ar,thumb_url,model_id,error,created_at,models(analysis)';
async function designList() {
  if (!sessionUser) return [];
  return (unwrap(await sb.from('designs').select(DESIGN_COLS).eq('user_id', sessionUser.id).order('created_at', { ascending: false }).limit(60)) || []).map(designDTO);
}
async function designGet(id) {
  const d = unwrap(await sb.from('designs').select(DESIGN_COLS).eq('id', id).maybeSingle());
  if (!d) throw notFound('Design not found.');
  return designDTO(d);
}
async function designFromFn(res) {
  const d = res?.design || res;
  if (d?.id && (d.status === 'ready' || d.models)) return designGet(d.id).catch(() => designDTO(d));
  return designDTO(d);
}

// ---------------------------------------------------------------- quotes and cart
async function lineFor(b) {
  if (b.productSlug) {
    const p = (await loadCatalog()).find((x) => x.slug === b.productSlug);
    if (!p) throw notFound();
    return { line: defaultLine(p), title: { en: p.name_en, ar: p.name_ar }, thumb: p.images[0] || null, slug: p.slug, productId: p.id, kind: 'product' };
  }
  if (b.designId) {
    const d = await designGet(b.designId);
    if (d.status !== 'ready' || !d._analysis) throw notFound('Design not found.');
    return { line: { analysis: d._analysis }, title: d.title.en ? d.title : { en: d.prompt, ar: d.prompt }, thumb: d.thumb, designId: d.id, kind: 'design' };
  }
  throw bad('Nothing to quote.');
}

async function quote(b) {
  const r = await reference();
  const ctx = pricingCtx(r);
  const { line } = await lineFor(b);
  const priced = pricing.priceLine(ctx, { ...line, material: b.material, color: b.color, scale: b.scale, infill: b.infill, quantity: b.quantity || 1 });
  const q = pricing.quoteLines(ctx, [priced], await destinationFor(b));
  return {
    breakdown: q.breakdown, taxRate: q.taxRate, shipping: q.shipping, shipsToDestination: q.shipsToDestination, destination: q.destination, currency: q.currency, display: q.display,
    line: { sizeMm: priced.sizeMm, weightGrams: priced.weightGrams, unitWeightGrams: priced.unitWeightGrams, pricePerGram: priced.pricePerGram, materialName: priced.materialName, colorName: priced.colorName, colorHex: priced.colorHex },
    printability: priced.printability,
  };
}

async function cartView(src = {}) {
  const r = await reference();
  const ctx = pricingCtx(r);
  const dest = await destinationFor(src);
  const rows = cartLines();
  const lines = [];
  const problems = [];
  for (const row of rows) {
    try {
      const { line, title, thumb, slug, designId, kind } = await lineFor({ productSlug: row.productSlug, designId: row.designId });
      const priced = pricing.priceLine(ctx, { ...line, material: row.material, color: row.color, scale: row.scale, infill: row.infill, quantity: row.quantity });
      lines.push({ ...priced, cartItemId: row.id, kind, title, thumb, slug, designId, row });
    } catch (err) {
      problems.push({ cartItemId: row.id, message: err.message });
    }
  }
  const q = lines.length ? pricing.quoteLines(ctx, lines, dest) : null;
  return {
    destination: dest,
    items: lines.map((l) => ({
      id: l.cartItemId, kind: l.kind, title: l.title, thumb: l.thumb, slug: l.slug || null, designId: l.designId || null, material: l.material, materialName: l.materialName,
      color: l.color, colorName: l.colorName, colorHex: l.colorHex, scale: l.scale, infill: l.infill, quantity: l.quantity, sizeMm: l.sizeMm, weightGrams: l.weightGrams,
      filamentCents: l.filamentCents, printable: l.printability.ok, needsSupports: l.printability.needsSupports,
    })),
    problems,
    quote: q && { breakdown: q.breakdown, taxRate: q.taxRate, shipping: q.shipping, display: q.display, shipsToDestination: q.shipsToDestination, printable: q.printable, currency: q.currency },
    count: cartCount(),
  };
}

async function cartAdd(b) {
  const { kind, slug, designId, productId } = await lineFor(b);
  const r = await reference();
  pricing.priceLine(pricingCtx(r), { ...(await lineFor(b)).line, material: b.material, color: b.color, scale: b.scale, infill: b.infill, quantity: b.quantity || 1 });
  addLine({ kind, productId: productId || null, productSlug: slug || null, designId: designId || null, material: b.material, color: b.color, scale: Number(b.scale), infill: Number(b.infill), quantity: Number(b.quantity) || 1 });
  return cartView(b);
}

// ---------------------------------------------------------------- addresses
const addrDTO = (a) => ({ id: a.id, label: a.label, fullName: a.full_name, phone: a.phone, line1: a.line1, line2: a.line2, city: a.city, region: a.region, postalCode: a.postal_code, country: a.country, isDefault: a.is_default });
const addrRow = (b) => ({ label: String(b.label || '').slice(0, 40), full_name: String(b.fullName || '').trim().slice(0, 80), phone: String(b.phone || '').slice(0, 30), line1: String(b.line1 || '').trim().slice(0, 120), line2: String(b.line2 || '').slice(0, 120), city: String(b.city || '').trim().slice(0, 60), region: String(b.region || '').slice(0, 60), postal_code: String(b.postalCode || '').slice(0, 20), country: String(b.country || 'SA').toUpperCase().slice(0, 2) });
let addrCache = null;
async function addressList({ fresh = false } = {}) {
  if (!sessionUser) throw unauthorized();
  if (addrCache && !fresh) return addrCache;
  addrCache = (unwrap(await sb.from('addresses').select('*').eq('user_id', sessionUser.id).order('is_default', { ascending: false }).order('id')) || []).map(addrDTO);
  return addrCache;
}
async function addressCreate(b) {
  if (!sessionUser) throw unauthorized();
  const row = addrRow(b);
  if (row.full_name.length < 2 || !row.line1 || !row.city) throw bad('Fill in the name, street and city.');
  const list = await addressList({ fresh: true });
  const a = unwrap(await sb.from('addresses').insert({ ...row, user_id: sessionUser.id, is_default: list.length === 0 }).select().single());
  addrCache = null;
  return addrDTO(a);
}
async function addressUpdate(id, b) {
  if (!sessionUser) throw unauthorized();
  if (b.makeDefault) {
    unwrap(await sb.from('addresses').update({ is_default: false }).eq('user_id', sessionUser.id));
    unwrap(await sb.from('addresses').update({ is_default: true }).eq('id', id));
  } else {
    unwrap(await sb.from('addresses').update(addrRow(b)).eq('id', id));
  }
  addrCache = null;
  return (await addressList()).find((a) => a.id === Number(id));
}
async function addressDelete(id) {
  unwrap(await sb.from('addresses').delete().eq('id', id));
  addrCache = null;
  return { ok: true };
}

// ---------------------------------------------------------------- wishlist
async function wishlist() {
  if (!sessionUser) throw unauthorized();
  const [r, list] = await Promise.all([reference(), loadCatalog()]);
  const ids = (unwrap(await sb.from('wishlist').select('product_id').eq('user_id', sessionUser.id)) || []).map((x) => x.product_id);
  const ctx = pricingCtx(r);
  const dest = await destinationFor({});
  return list.filter((p) => ids.includes(p.id)).map((p) => productCard(p, ctx, dest));
}

// ---------------------------------------------------------------- orders
const orderDisplay = (o) => (o.display_currency ? { currency: o.display_currency, rate: Number(o.fx_rate), total: o.charged_amount ?? pricing.convert(o.total_cents, { rate: Number(o.fx_rate), decimals: 2 }), decimals: 2 } : null);
const ORDER_COLS = 'id,number,status,total_cents,display_currency,fx_rate,charged_amount,created_at,paid_at,country,region,address,pricing,payment,refunded_cents,tracking,order_items(id,product_id,design_id,model_id,title_en,title_ar,material,color,scale,infill,quantity,size_mm,weight_g,filament_cents,thumb_url),order_events(status,detail,created_at),print_jobs(order_item_id,copy_index,status,progress)';
function orderSummary(o, { full = false } = {}) {
  const items = o.order_items || [];
  const base = {
    id: o.id, number: o.number, status: o.status, totalCents: o.total_cents, currency: 'SAR', createdAt: o.created_at, paidAt: o.paid_at, display: orderDisplay(o),
    itemCount: items.reduce((s, i) => s + i.quantity, 0), thumbs: items.slice(0, 4).map((i) => mediaUrl(i.thumb_url)),
  };
  if (!full) return base;
  const mats = ref?.materials || [];
  const colorHex = (m, c) => mats.find((x) => x.code === m)?.colors?.find((x) => x.code === c)?.hex || '#999';
  const slugs = Object.fromEntries((catalog || []).map((p) => [p.id, p.slug]));
  return {
    ...base, address: o.address, pricing: o.pricing, carrier: o.tracking?.carrier || null, trackingNumber: o.tracking?.number || null, refundedCents: o.refunded_cents,
    paymentProvider: o.payment?.provider || null, paymentRef: o.payment?.reference || null,
    events: (o.order_events || []).map((e) => ({ status: e.status, note: e.detail, created_at: e.created_at })).sort((a, b) => (a.created_at < b.created_at ? -1 : 1)),
    items: items.map((i) => ({
      id: i.id, kind: i.design_id ? 'design' : 'product', title: { en: i.title_en, ar: i.title_ar }, thumb: mediaUrl(i.thumb_url), material: i.material, color: i.color, colorHex: colorHex(i.material, i.color),
      scale: Number(i.scale), infill: i.infill, quantity: i.quantity, sizeMm: i.size_mm, weightGrams: Number(i.weight_g), filamentCents: i.filament_cents, productSlug: i.product_id ? slugs[i.product_id] || null : null,
      jobs: (o.print_jobs || []).filter((j) => j.order_item_id === i.id).map((j) => ({ copy: j.copy_index, status: j.status === 'done' ? 'printed' : j.status, progress: Math.round(j.progress || 0) })),
    })),
    jobs: (o.print_jobs || []).map((j) => ({ id: j.id, status: j.status, progress: j.progress || 0 })),
  };
}
async function ownOrder(number) {
  if (!sessionUser) throw unauthorized();
  const o = unwrap(await sb.from('orders').select(ORDER_COLS).eq('number', number).maybeSingle());
  if (!o) throw notFound('Order not found.');
  return o;
}

async function checkout(b) {
  if (!sessionUser) throw unauthorized();
  const lines = cartLines().map((l) => ({ productId: l.productId || undefined, designId: l.designId || undefined, material: l.material, color: l.color, scale: l.scale, infill: l.infill, quantity: l.quantity }));
  if (!lines.length) throw bad('Your cart is empty.');
  const res = await callFn('checkout', { lines, addressId: b.addressId, locale: b.locale || 'en' });
  clearCart();
  const o = res.order || res;
  return { number: o.number, ...o };
}

// ---------------------------------------------------------------- admin helpers
const requireAdmin = () => { if (sessionUser?.role !== 'admin') throw new ApiError(403, { error: { message: 'Admins only.', code: 'forbidden' } }); };
const ADMIN_ORDER_COLS = `${ORDER_COLS},user_id,profiles(name,email)`;
function adminOrderDTO(o) {
  const s = orderSummary(o, { full: true });
  return { ...s, customer: o.profiles ? { name: o.profiles.name, email: o.profiles.email } : null, items: s.items.map((i) => ({ ...i, needsSupports: false })) };
}

async function adminOverview() {
  requireAdmin();
  const since = new Date(Date.now() - 30 * 86400e3).toISOString();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const [orders, jobs, printers, designs] = await Promise.all([
    sb.from('orders').select(ADMIN_ORDER_COLS).gte('created_at', since).order('created_at', { ascending: false }).limit(200),
    sb.from('print_jobs').select('id,status,progress,printer_id,order_item_id').not('status', 'in', '("done","cancelled")'),
    sb.from('printers').select('*,printer_types(name,driver,bed)'),
    sb.from('designs').select('id', { count: 'exact', head: true }).gte('created_at', today.toISOString()),
  ]);
  const list = unwrap(orders) || [];
  const paid = list.filter((o) => o.paid_at);
  const sum = (arr) => arr.reduce((s, o) => s + o.total_cents - (o.refunded_cents || 0), 0);
  const todays = paid.filter((o) => new Date(o.paid_at) >= today);
  const orderCounts = {};
  for (const o of list) orderCounts[o.status] = (orderCounts[o.status] || 0) + 1;
  const jobCounts = {};
  for (const j of unwrap(jobs) || []) jobCounts[j.status] = (jobCounts[j.status] || 0) + 1;
  return {
    today: { cents: sum(todays), n: todays.length }, month: { cents: sum(paid), n: paid.length }, orderCounts, jobCounts, aiDesignsToday: designs.count || 0,
    printers: (unwrap(printers) || []).map(printerDTO), recentOrders: list.slice(0, 8).map(adminOrderDTO),
  };
}

function printerDTO(p) {
  return {
    id: p.id, name: p.name, driver: p.printer_types?.driver || p.type_code, driverLabel: p.printer_types?.name || p.type_code, typeCode: p.type_code, bed: p.printer_types?.bed || { x: 0, y: 0, z: 0 },
    materials: p.materials || [], ams: p.slots || [], address: p.address, serial: p.serial, access_code: p.access_code, nozzleMm: Number(p.nozzle_mm), active: p.active,
    status: p.active ? (p.status || 'offline') : 'offline', detail: p.status_detail, progress: 0, job: null, lastSeen: p.last_seen,
  };
}

async function adminOrders(q) {
  requireAdmin();
  let query = sb.from('orders').select(ADMIN_ORDER_COLS).order('created_at', { ascending: false }).limit(200);
  if (q.status) query = query.eq('status', q.status);
  const list = (unwrap(await query) || []).map(adminOrderDTO);
  if (q.q) { const s = q.q.toLowerCase(); return list.filter((o) => o.number.toLowerCase().includes(s) || o.customer?.email?.toLowerCase().includes(s) || o.customer?.name?.toLowerCase().includes(s)); }
  return list;
}
async function adminOrder(id) {
  requireAdmin();
  const o = unwrap(await sb.from('orders').select(ADMIN_ORDER_COLS).eq('id', id).maybeSingle());
  if (!o) throw notFound();
  return adminOrderDTO(o);
}

async function adminQueue() {
  requireAdmin();
  const rows = unwrap(await sb.from('print_jobs').select('*,order_items(title_en,title_ar,material,color,scale,infill,thumb_url),orders(number),printers(name)').order('created_at').limit(300)) || [];
  const mats = ref?.materials || [];
  return rows.map((j) => ({
    id: j.id, order_number: j.orders?.number, title_en: j.order_items?.title_en, title_ar: j.order_items?.title_ar, thumb: mediaUrl(j.order_items?.thumb_url), scale: Number(j.order_items?.scale || 1), infill: j.order_items?.infill,
    material: j.order_items?.material, color_hex: mats.find((m) => m.code === j.order_items?.material)?.colors?.find((c) => c.code === j.order_items?.color)?.hex || '#999',
    status: j.status === 'done' ? 'printed' : j.status, held: j.status === 'paused', error: j.error, printer_name: j.printers?.name, progress: j.progress || 0, stats: j.stats || {},
  }));
}
async function adminJob(id, act) {
  requireAdmin();
  const patch = { cancel: { status: 'cancelled' }, pause: { status: 'paused' }, resume: { status: 'queued' }, reprint: { status: 'queued', progress: 0, error: null, attempts: 0, printer_id: null } }[act];
  if (!patch) return { ok: true, ignored: act };
  unwrap(await sb.from('print_jobs').update(patch).eq('id', id));
  return { ok: true };
}

const PRINTER_COLS = '*,printer_types(name,driver,bed)';
async function adminPrinters() {
  requireAdmin();
  const [printers, types] = await Promise.all([sb.from('printers').select(PRINTER_COLS).order('id'), sb.from('printer_types').select('*').order('sort')]);
  return { printers: (unwrap(printers) || []).map(printerDTO), types: unwrap(types) || [] };
}
const printerRow = (b) => ({ name: String(b.name || '').trim().slice(0, 80), type_code: b.typeCode, address: String(b.address || '').trim(), serial: String(b.serial || '').trim(), access_code: String(b.accessCode || ''), nozzle_mm: Number(b.nozzleMm) || 0.4, materials: b.materials || [], slots: b.slots || [], active: Boolean(b.active) });

async function adminProducts() {
  requireAdmin();
  const rows = unwrap(await sb.from('products').select(PRODUCT_COLS).order('id')) || [];
  return rows.map((p) => ({
    id: p.id, slug: p.slug, modelId: p.model_id, name: { en: p.name_en, ar: p.name_ar }, description: { en: p.desc_en, ar: p.desc_ar }, images: (p.images || []).map(mediaUrl), categoryId: p.category_id,
    defaultMaterial: p.default_material, defaultColor: p.default_color, allowedMaterials: p.allowed_materials || [], defaultScale: Number(p.default_scale), minScale: Number(p.min_scale), maxScale: Number(p.max_scale),
    defaultInfill: p.default_infill, tags: p.tags, featured: Boolean(p.featured), active: Boolean(p.active), soldCount: p.sold_count, rating: ratingOf(p.id).rating, analysis: p.models?.analysis ? pricing.publicAnalysis(p.models.analysis) : null,
  }));
}
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `item-${Date.now()}`;
function productRow(b) {
  return {
    category_id: b.categoryId || null, name_en: b.name.en, name_ar: b.name.ar || b.name.en, desc_en: b.description?.en || '', desc_ar: b.description?.ar || '', default_material: b.defaultMaterial, default_color: b.defaultColor,
    allowed_materials: b.allowedMaterials, default_scale: b.defaultScale, min_scale: b.minScale, max_scale: b.maxScale, default_infill: b.defaultInfill, tags: b.tags || '', featured: Boolean(b.featured), active: Boolean(b.active),
  };
}

async function adminSettings() {
  requireAdmin();
  const r = await reference({ fresh: true });
  return {
    ...r.settings, currencies: r.currencies, infill_range: r.settings.infill_range || [30, 40], min_wall_mm: r.settings.min_wall_mm ?? 2, max_model_mm: r.settings.max_model_mm ?? 250,
    fee_tiers: r.settings.fee_tiers || pricing.DEFAULT_FEE_TIERS, wall_thickness_mm: r.settings.wall_thickness_mm ?? 2.1, store_name: r.settings.store_name || 'Prompt2Print', currency: 'SAR',
    default_country: r.settings.default_country || 'SA', ai_provider: r.settings.ai_provider || 'auto', ai_hourly_limit: r.settings.ai_hourly_limit ?? 30, ai_default_size_mm: r.settings.ai_default_size_mm ?? 100,
    payment_provider: r.settings.payment_provider || 'tap', fallback_currency: r.settings.fallback_currency || 'USD',
  };
}
async function adminSaveSettings(b) {
  requireAdmin();
  const { currencies, ...rest } = b;
  const numeric = ['wall_thickness_mm', 'min_wall_mm', 'max_model_mm', 'ai_hourly_limit', 'ai_default_size_mm'];
  const rows = Object.entries(rest).filter(([k]) => !['currency'].includes(k)).map(([k, v]) => ({ key: k, value: numeric.includes(k) ? Number(v) : v }));
  if (rows.length) unwrap(await sb.from('settings').upsert(rows, { onConflict: 'key' }));
  if (Array.isArray(currencies)) {
    const clean = currencies.filter((c) => /^[A-Z]{3}$/.test(String(c.code || '').toUpperCase())).map((c, i) => ({ code: c.code.toUpperCase(), name: c.code.toUpperCase(), rate: Number(c.rate) || 1, decimals: Number(c.decimals) || 0, sort: i }));
    if (clean.length) unwrap(await sb.from('currencies').upsert(clean, { onConflict: 'code' }));
  }
  await audit('settings.update', Object.keys(rest).join(','));
  await reference({ fresh: true });
  return { ok: true };
}
async function audit(action, detail) {
  try { await sb.from('audit_log').insert({ user_id: sessionUser?.id, email: sessionUser?.email, action, detail: { detail } }); } catch { /* best effort */ }
}

async function adminUsers(q) {
  requireAdmin();
  const [profiles, orders] = await Promise.all([sb.from('profiles').select('id,email,name,role,disabled,created_at').order('created_at', { ascending: false }).limit(500), sb.from('orders').select('user_id,total_cents,refunded_cents,paid_at')]);
  const spent = {};
  for (const o of unwrap(orders) || []) if (o.paid_at) { const s = spent[o.user_id] || (spent[o.user_id] = { n: 0, cents: 0 }); s.n += 1; s.cents += o.total_cents - (o.refunded_cents || 0); }
  let list = (unwrap(profiles) || []).map((u) => ({ ...u, orders: spent[u.id]?.n || 0, spent_cents: spent[u.id]?.cents || 0 }));
  if (q.q) { const s = q.q.toLowerCase(); list = list.filter((u) => u.email.toLowerCase().includes(s) || u.name.toLowerCase().includes(s)); }
  return list;
}

async function adminReports(days) {
  requireAdmin();
  const since = new Date(Date.now() - days * 86400e3).toISOString();
  const rows = unwrap(await sb.from('orders').select('id,country,total_cents,refunded_cents,paid_at,pricing,order_items(product_id,design_id,title_en,title_ar,material,quantity,weight_g,filament_cents,print_time_sec)').gte('paid_at', since).not('paid_at', 'is', null)) || [];
  const split = { filamentCents: 0, taxCents: 0, shippingCents: 0, feeCents: 0, refundedCents: 0 };
  const byDayMap = {}; const mats = {}; const kinds = { product: { qty: 0, cents: 0 }, design: { qty: 0, cents: 0 } }; const top = {}; const countries = {};
  let gross = 0, refunded = 0, printSec = 0;
  for (const o of rows) {
    gross += o.total_cents; refunded += o.refunded_cents || 0;
    const p = o.pricing || {};
    split.filamentCents += p.filamentCents || 0; split.taxCents += p.taxCents || 0; split.shippingCents += p.shippingCents || 0; split.feeCents += p.feeCents || 0;
    const day = o.paid_at.slice(0, 10);
    const d = byDayMap[day] || (byDayMap[day] = { date: day, revenueCents: 0, orders: 0 });
    d.revenueCents += o.total_cents; d.orders += 1;
    const c = countries[o.country] || (countries[o.country] = { country: o.country, orders: 0, cents: 0 });
    c.orders += 1; c.cents += o.total_cents;
    for (const i of o.order_items || []) {
      mats[i.material] = (mats[i.material] || 0) + Number(i.weight_g || 0);
      const k = i.design_id ? 'design' : 'product';
      kinds[k].qty += i.quantity; kinds[k].cents += i.filament_cents;
      printSec += (i.print_time_sec || 0) * i.quantity;
      if (i.product_id) { const tp = top[i.product_id] || (top[i.product_id] = { title_en: i.title_en, title_ar: i.title_ar, qty: 0, filament_cents: 0 }); tp.qty += i.quantity; tp.filament_cents += i.filament_cents; }
    }
  }
  split.refundedCents = refunded;
  const byDay = [];
  for (let i = days - 1; i >= 0; i--) { const date = new Date(Date.now() - i * 86400e3).toISOString().slice(0, 10); byDay.push(byDayMap[date] || { date, revenueCents: 0, orders: 0 }); }
  return {
    totals: { grossCents: gross, netCents: gross - refunded, orders: rows.length, avgOrderCents: rows.length ? Math.round(gross / rows.length) : 0 }, printHours: printSec / 3600, byDay, split,
    materials: Object.entries(mats).map(([material, grams]) => ({ material, grams })), kinds: Object.entries(kinds).map(([kind, v]) => ({ kind, qty: v.qty, filament_cents: v.cents })),
    topProducts: Object.values(top).sort((a, b) => b.qty - a.qty).slice(0, 10), countries: Object.values(countries).sort((a, b) => b.orders - a.orders),
  };
}

// ---------------------------------------------------------------- the router
const routes = [];
const on = (method, pattern, handler) => {
  const keys = [];
  const rx = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
  routes.push({ method, rx, keys, handler });
};

// store
on('GET', '/api/bootstrap', (p, q) => bootstrap(q));
on('GET', '/api/products', (p, q) => products(q));
on('GET', '/api/products/:slug', (p, q) => productDetail(p.slug, q));
on('GET', '/api/products/:slug/reviews', (p) => reviewsOf(p.slug));
on('POST', '/api/products/:slug/reviews', (p, q, b) => postReview(p.slug, b));
on('POST', '/api/quote', (p, q, b) => quote(b));
on('GET', '/api/addresses', () => addressList({ fresh: true }));
on('POST', '/api/addresses', (p, q, b) => addressCreate(b));
on('PATCH', '/api/addresses/:id', (p, q, b) => addressUpdate(Number(p.id), b));
on('DELETE', '/api/addresses/:id', (p) => addressDelete(Number(p.id)));
on('GET', '/api/wishlist', () => wishlist());
on('POST', '/api/wishlist', async (p, q, b) => { if (!sessionUser) throw unauthorized(); unwrap(await sb.from('wishlist').upsert({ user_id: sessionUser.id, product_id: b.productId })); return { ok: true }; });
on('DELETE', '/api/wishlist/:productId', async (p) => { if (!sessionUser) throw unauthorized(); unwrap(await sb.from('wishlist').delete().eq('user_id', sessionUser.id).eq('product_id', Number(p.productId))); return { ok: true }; });
on('GET', '/api/cart', (p, q) => cartView(q));
on('POST', '/api/cart/items', (p, q, b) => cartAdd(b));
on('PATCH', '/api/cart/items/:id', (p, q, b) => { updateLine(p.id, { quantity: Math.min(50, Math.max(1, Math.round(Number(b.quantity) || 1))) }); return cartView(b); });
on('DELETE', '/api/cart/items/:id', (p, q) => { removeLine(p.id); return cartView(q); });
on('GET', '/api/designs', () => designList());
on('POST', '/api/designs', async (p, q, b) => { if (!sessionUser) throw unauthorized(); return designFromFn(await callFn('designs', { action: 'create', prompt: b.prompt, parentId: b.parentId || undefined, locale: b.locale || 'en' })); });
on('GET', '/api/designs/:id', (p) => designGet(p.id));
on('POST', '/api/designs/:id/regenerate', async (p) => designFromFn(await callFn('designs', { action: 'regenerate', id: p.id })));
on('POST', '/api/checkout', (p, q, b) => checkout(b));
on('GET', '/api/orders', async () => { if (!sessionUser) throw unauthorized(); return (unwrap(await sb.from('orders').select(ORDER_COLS).eq('user_id', sessionUser.id).order('created_at', { ascending: false }).limit(100)) || []).map((o) => orderSummary(o)); });
on('GET', '/api/orders/:number', async (p) => { await loadCatalog(); await reference(); return orderSummary(await ownOrder(p.number), { full: true }); });
on('POST', '/api/orders/:number/pay/:gateway', (p, q, b) => callFn('pay', { orderNumber: p.number, returnUrl: b?.returnUrl || `https://bdy612.github.io/Prompt2Print/paid.html?order=${encodeURIComponent(p.number)}` }).then((r) => ({ redirectUrl: r.url, ...r })));
on('POST', '/api/orders/:number/confirm', async (p, q, b) => { const r = await callFn('pay', { orderNumber: p.number, confirm: true, tapId: b?.tapId }); await loadCatalog(); return orderSummary(r.order || (await ownOrder(p.number)), { full: true }); });
on('PATCH', '/api/me', async (p, q, b) => {
  if (!sessionUser) throw unauthorized();
  if (b.newPassword) {
    if (String(b.newPassword).length < 8) throw bad('Use at least 8 characters for your new password.');
    const check = await sb.auth.signInWithPassword({ email: sessionUser.email, password: String(b.currentPassword || '') });
    if (check.error) throw bad('Your current password is incorrect.');
    unwrap(await sb.auth.updateUser({ password: String(b.newPassword) }));
  }
  const patch = {};
  if (b.locale) patch.locale = b.locale === 'ar' ? 'ar' : 'en';
  if (b.name && String(b.name).trim().length >= 2) patch.name = String(b.name).trim().slice(0, 80);
  if (Object.keys(patch).length) { unwrap(await sb.from('profiles').update(patch).eq('id', sessionUser.id)); Object.assign(sessionUser, patch); try { localStorage.removeItem(`p2p_profile:${sessionUser.id}`); } catch { /* ignore */ } }
  return { ok: true };
});
on('POST', '/api/auth/logout', async () => { await signOut(); return { ok: true }; });

// admin
on('GET', '/api/admin/overview', () => adminOverview());
on('GET', '/api/admin/orders', (p, q) => adminOrders(q));
on('GET', '/api/admin/orders/:id', (p) => adminOrder(p.id));
on('POST', '/api/admin/orders/:id/advance', (p, q, b) => callFn('admin', { action: 'order', id: p.id, do: 'advance', to: b.to, carrier: b.carrier, trackingNumber: b.trackingNumber }));
on('POST', '/api/admin/orders/:id/cancel', (p) => callFn('admin', { action: 'order', id: p.id, do: 'cancel' }));
on('POST', '/api/admin/orders/:id/refund', (p, q, b) => callFn('admin', { action: 'order', id: p.id, do: 'refund', amountCents: b.amountCents, reason: b.reason }));
on('GET', '/api/admin/queue', () => adminQueue());
on('POST', '/api/admin/jobs/:id/:act', (p) => adminJob(Number(p.id), p.act));
on('GET', '/api/admin/printers', () => adminPrinters());
on('POST', '/api/admin/printers', async (p, q, b) => { requireAdmin(); unwrap(await sb.from('printers').insert(printerRow(b))); await audit('printer.create', b.name); return { ok: true }; });
on('PUT', '/api/admin/printers/:id', async (p, q, b) => { requireAdmin(); unwrap(await sb.from('printers').update(printerRow(b)).eq('id', Number(p.id))); await audit('printer.update', b.name); return { ok: true }; });
on('DELETE', '/api/admin/printers/:id', async (p) => { requireAdmin(); unwrap(await sb.from('printers').delete().eq('id', Number(p.id))); return { ok: true }; });
on('POST', '/api/admin/printers/:id/test', (p) => callFn('admin', { action: 'printer-test', id: Number(p.id) }).catch((e) => ({ ok: false, message: e.message })));
on('POST', '/api/admin/printers/:id/clear', async (p) => { requireAdmin(); unwrap(await sb.from('printers').update({ status: 'idle', status_detail: '' }).eq('id', Number(p.id))); return { ok: true }; });
on('GET', '/api/admin/products', () => adminProducts());
on('GET', '/api/admin/categories', async () => { requireAdmin(); return unwrap(await sb.from('categories').select('*').order('sort')); });
on('POST', '/api/admin/products', async (p, q, b) => {
  requireAdmin();
  if (!b.modelId) throw bad('Generate or upload a model first.');
  const model = unwrap(await sb.from('models').select('thumb_url').eq('id', b.modelId).maybeSingle());
  unwrap(await sb.from('products').insert({ ...productRow(b), slug: slugify(b.name.en), model_id: b.modelId, images: model?.thumb_url ? [model.thumb_url] : [] }));
  catalogAt = 0; return { ok: true };
});
on('PUT', '/api/admin/products/:id', async (p, q, b) => { requireAdmin(); unwrap(await sb.from('products').update(productRow(b)).eq('id', Number(p.id))); catalogAt = 0; return { ok: true }; });
on('DELETE', '/api/admin/products/:id', async (p) => {
  requireAdmin();
  const { count } = await sb.from('order_items').select('id', { count: 'exact', head: true }).eq('product_id', Number(p.id));
  if (count) { unwrap(await sb.from('products').update({ active: false }).eq('id', Number(p.id))); catalogAt = 0; return { archived: true }; }
  unwrap(await sb.from('products').delete().eq('id', Number(p.id))); catalogAt = 0; return { ok: true };
});
on('POST', '/api/admin/models/generate', (p, q, b) => callFn('admin', { action: 'generate', prompt: b.prompt, seed: b.seed }).then((r) => ({ ...r, preview: mediaUrl(r.preview || r.thumbUrl) })));
on('POST', '/api/admin/models/upload', () => { throw bad('Uploading model files is not available in this version. Describe the item instead and generate it.'); });
on('GET', '/api/admin/materials', async () => { requireAdmin(); return unwrap(await sb.from('materials').select('*').order('sort')); });
on('PUT', '/api/admin/materials/:code', async (p, q, b) => {
  requireAdmin();
  const row = { price_per_gram: Number(b.price_per_gram), density: Number(b.density), active: Boolean(b.active), colors: (b.colors || []).map((c) => ({ code: String(c.code).toLowerCase().replace(/[^a-z0-9-]/g, ''), name_en: c.name_en, name_ar: c.name_ar, hex: c.hex, in_stock: c.in_stock !== false })) };
  unwrap(await sb.from('materials').update(row).eq('code', p.code)); await audit('material.update', p.code); await reference({ fresh: true }); catalogAt = 0; return { ok: true };
});
on('GET', '/api/admin/settings', () => adminSettings());
on('PUT', '/api/admin/settings', (p, q, b) => adminSaveSettings(b));
on('GET', '/api/admin/taxes', async () => { requireAdmin(); return unwrap(await sb.from('tax_rates').select('*').order('country').order('region')); });
on('POST', '/api/admin/taxes', async (p, q, b) => { requireAdmin(); unwrap(await sb.from('tax_rates').upsert({ country: String(b.country).toUpperCase(), region: String(b.region || '*').toUpperCase() || '*', rate: Number(b.rate), label: b.label || '' }, { onConflict: 'country,region' })); await reference({ fresh: true }); return { ok: true }; });
on('DELETE', '/api/admin/taxes/:id', async (p) => { requireAdmin(); unwrap(await sb.from('tax_rates').delete().eq('id', Number(p.id))); await reference({ fresh: true }); return { ok: true }; });
on('GET', '/api/admin/shipping', async () => { requireAdmin(); return unwrap(await sb.from('shipping_zones').select('*').order('sort').order('id')); });
const zoneRow = (b) => ({ name_en: b.name_en, name_ar: b.name_ar || b.name_en, countries: String(b.countries || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean), base_cents: b.base_cents, per_kg_cents: b.per_kg_cents, volumetric_divisor: Number(b.volumetric_divisor) || 5000, min_days: Number(b.min_days) || 3, max_days: Number(b.max_days) || 7, active: Boolean(b.active) });
on('POST', '/api/admin/shipping', async (p, q, b) => { requireAdmin(); unwrap(await sb.from('shipping_zones').insert(zoneRow(b))); await reference({ fresh: true }); return { ok: true }; });
on('PUT', '/api/admin/shipping/:id', async (p, q, b) => { requireAdmin(); unwrap(await sb.from('shipping_zones').update(zoneRow(b)).eq('id', Number(p.id))); await reference({ fresh: true }); return { ok: true }; });
on('DELETE', '/api/admin/shipping/:id', async (p) => { requireAdmin(); unwrap(await sb.from('shipping_zones').delete().eq('id', Number(p.id))); await reference({ fresh: true }); return { ok: true }; });
on('GET', '/api/admin/users', (p, q) => adminUsers(q));
on('PUT', '/api/admin/users/:id', async (p, q, b) => { requireAdmin(); const patch = {}; if (b.role) patch.role = b.role; if (b.disabled !== undefined) patch.disabled = Boolean(b.disabled); unwrap(await sb.from('profiles').update(patch).eq('id', p.id)); await audit('user.update', `${p.id} ${JSON.stringify(patch)}`); return { ok: true }; });
on('GET', '/api/admin/audit', async () => { requireAdmin(); return (unwrap(await sb.from('audit_log').select('*').order('created_at', { ascending: false }).limit(100)) || []).map((x) => ({ ...x, detail: typeof x.detail === 'object' ? (x.detail?.detail || JSON.stringify(x.detail)) : x.detail })); });
on('GET', '/api/admin/reports', (p, q) => adminReports(Number(q.days) || 30));

export async function api(path, { method = 'GET', body } = {}) {
  const [pathname, search = ''] = String(path).split('?');
  const query = Object.fromEntries(new URLSearchParams(search));
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = pathname.match(r.rx);
    if (!m) continue;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    return r.handler(params, query, body || {});
  }
  throw notFound(`No handler for ${method} ${pathname}`);
}

// Used by pages that need the raw tables (admin printer types) without going through the router.
export { sb, mediaUrl, reference, loadCatalog };
