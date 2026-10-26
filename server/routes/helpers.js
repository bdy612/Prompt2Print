import { get, all, parseJson, getSetting } from '../db.js';
import { priceLine, quoteLines } from '../pricing/quote.js';
import { getModel } from '../models.js';

// Where are we delivering to? An address id, explicit country/region, the default address, or the shop default.
export function destinationFrom(req, src = {}) {
  if (req.user && src.addressId) {
    const a = get('SELECT * FROM addresses WHERE id = ? AND user_id = ?', [Number(src.addressId), req.user.id]);
    if (a) return { country: a.country, region: a.region || '', addressId: a.id };
  }
  if (src.country) return { country: String(src.country).toUpperCase().slice(0, 2), region: String(src.region || '').slice(0, 40) };
  if (req.user) {
    const a = get('SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, id LIMIT 1', req.user.id);
    if (a) return { country: a.country, region: a.region || '', addressId: a.id };
  }
  return { country: getSetting('default_country', 'SA'), region: '' };
}

export function productBase(p) {
  return {
    id: p.id,
    slug: p.slug,
    modelId: p.model_id,
    name: { en: p.name_en, ar: p.name_ar },
    images: parseJson(p.images, []),
    rating: Math.round(p.rating_avg * 10) / 10,
    ratingCount: p.rating_count,
    soldCount: p.sold_count,
    featured: Boolean(p.featured),
    categoryId: p.category_id,
  };
}

export function defaultLine(p, analysis) {
  return {
    analysis,
    material: p.default_material,
    color: p.default_color,
    scale: p.default_scale,
    infill: p.default_infill,
    quantity: 1,
    allowedMaterials: parseJson(p.allowed_materials, []),
    minScale: p.min_scale,
    maxScale: p.max_scale,
  };
}

// Product card with its delivered price for the default options.
const pricedFragile = (q) => Boolean(q.lines?.[0]?.printability?.fragile);

export function productCard(p, ctx, dest) {
  const analysis = getModel(p.model_id)?.analysis;
  let price = null;
  try {
    const q = quoteLines(ctx, [priceLine(ctx, defaultLine(p, analysis))], dest);
    price = { totalCents: q.breakdown.totalCents, shipsToDestination: q.shipsToDestination, display: q.display, fragile: pricedFragile(q) };
  } catch { /* product misconfigured: show without price */ }
  return { ...productBase(p), price };
}

export function designDTO(d) {
  const model = d.model_id ? getModel(d.model_id) : null;
  return {
    id: d.id,
    prompt: d.prompt,
    seed: d.seed,
    parentId: d.parent_id,
    status: d.status,
    progress: d.progress,
    provider: d.provider,
    title: { en: d.title_en, ar: d.title_ar },
    thumb: d.thumb,
    error: d.error,
    modelId: d.model_id,
    analysis: model ? publicAnalysis(model.analysis) : null,
    createdAt: d.created_at,
  };
}

// What the browser may know about a model's geometry (no file, just numbers).
export function publicAnalysis(a) {
  return {
    sizeMm: a.bbox.size.map((v) => Math.round(v * 10) / 10),
    volumeCm3: Math.round(a.volumeMm3 / 100) / 10,
    triangles: a.triangles,
    watertight: a.watertight,
  };
}

export function userCanSeeModel(req, model) {
  if (!model) return false;
  if (model.source === 'catalog' || model.source === 'upload') {
    return Boolean(get('SELECT 1 FROM products WHERE model_id = ? AND active = 1', model.id)) || req.user?.role === 'admin';
  }
  if (req.user?.role === 'admin') return true;
  const own = req.user
    ? get('SELECT 1 FROM designs WHERE model_id = ? AND user_id = ?', [model.id, req.user.id])
    : get('SELECT 1 FROM designs WHERE model_id = ? AND guest_key = ? AND user_id IS NULL', [model.id, req.guestKey]);
  if (own) return true;
  return req.user ? Boolean(get('SELECT 1 FROM order_items i JOIN orders o ON o.id = i.order_id WHERE i.model_id = ? AND o.user_id = ?', [model.id, req.user.id])) : false;
}

export function materialsPublic(ctx) {
  return Object.values(ctx.materials).filter((m) => m.active).map((m) => ({
    code: m.code,
    name: { en: m.name_en, ar: m.name_ar },
    desc: { en: m.desc_en, ar: m.desc_ar },
    pricePerGram: m.price_per_gram,
    density: m.density,
    process: m.process,
    maxTempC: m.code === 'ASA' ? 100 : 85,
    // Only colours in stock are offered to customers.
    colors: m.colors.filter((c) => c.in_stock !== false && c.in_stock !== 0).map((c) => ({ code: c.code, name: { en: c.name_en, ar: c.name_ar }, hex: c.hex })),
  }));
}

export function categoriesPublic() {
  return all(`SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.active = 1) AS count,
                     (SELECT images FROM products p WHERE p.category_id = c.id AND p.active = 1 ORDER BY featured DESC, sold_count DESC LIMIT 1) AS cover
              FROM categories c ORDER BY sort, id`).map((c) => ({
    id: c.id, slug: c.slug, name: { en: c.name_en, ar: c.name_ar }, count: c.count, cover: parseJson(c.cover, [])[0] || null,
  }));
}
