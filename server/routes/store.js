// Storefront API: catalog, quotes, protected previews, accounts, cart, AI designs, checkout, orders.

import { all, get, run, parseJson, getSetting } from '../db.js';
import { bad, notFound, unauthorized, readJson, readBody, HttpError } from '../lib/http.js';
import {
  hashPasswordAsync, verifyPasswordAsync, createSession, destroySession, requireUser, adoptGuestData, ownerClause,
  checkLoginThrottle, recordLoginFailure, clearLoginFailures, audit,
} from '../auth.js';
import { clientIp } from '../designs.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const adminSetupNeeded = () => Boolean(get("SELECT 1 AS x FROM users WHERE role = 'admin' AND (password_hash = '' OR password_hash IS NULL) LIMIT 1"));
import { loadPricingContext, priceLine, quoteLines } from '../pricing/quote.js';
import { getModel, previewBuffer } from '../models.js';
import { createDesign } from '../designs.js';
import { createOrderFromCart, getOrderByNumber, priceCartRows } from '../orders.js';
import {
  activePaymentProvider, payWithTestCard, createStripeCheckout, confirmStripeSession, handleStripeWebhook, requirePayments,
  createTapPayment, confirmTapPayment, handleTapWebhook,
} from '../payments/index.js';
import { config } from '../config.js';
import { activeProvider } from '../ai/providers.js';
import { COUNTRIES } from '../lib/countries.js';
import { currencies, currencyFor } from '../lib/currency.js';
import {
  destinationFrom, productBase, productCard, defaultLine, designDTO, publicAnalysis, userCanSeeModel,
  materialsPublic, categoriesPublic,
} from './helpers.js';

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cartRows(req) {
  const o = ownerClause(req);
  return all(`SELECT * FROM cart_items WHERE ${o.sql} ORDER BY id`, o.params);
}

function cartView(req, src) {
  const ctx = loadPricingContext();
  const dest = destinationFrom(req, src);
  const rows = cartRows(req);
  const { lines, problems } = priceCartRows(ctx, rows);
  const quote = lines.length ? quoteLines(ctx, lines, dest) : null;
  return {
    destination: dest,
    items: lines.map((l) => ({
      id: l.cartItemId, kind: l.kind, title: { en: l.titleEn, ar: l.titleAr }, thumb: l.thumb, slug: l.slug || null, designId: l.designId || null,
      material: l.material, materialName: l.materialName, color: l.color, colorName: l.colorName, colorHex: l.colorHex,
      scale: l.scale, infill: l.infill, quantity: l.quantity, sizeMm: l.sizeMm, weightGrams: l.weightGrams,
      filamentCents: l.filamentCents, printable: l.printability.ok, needsSupports: l.printability.needsSupports,
    })),
    problems,
    quote: quote && {
      breakdown: quote.breakdown, taxRate: quote.taxRate, shipping: quote.shipping, display: quote.display,
      shipsToDestination: quote.shipsToDestination, printable: quote.printable, currency: quote.currency,
    },
    count: rows.reduce((s, r) => s + r.quantity, 0),
  };
}

function orderSummary(o, { full = false } = {}) {
  const base = {
    number: o.number, status: o.status, totalCents: o.total_cents, currency: o.currency, createdAt: o.created_at, paidAt: o.paid_at,
    display: o.display_currency ? { currency: o.display_currency, rate: o.fx_rate, total: o.charged_amount } : null,
    itemCount: o.items.reduce((s, i) => s + i.quantity, 0),
    thumbs: o.items.slice(0, 4).map((i) => i.thumb),
  };
  if (!full) return base;
  return {
    ...base,
    address: o.address,
    pricing: o.pricing,
    carrier: o.carrier,
    trackingNumber: o.tracking_number,
    refundedCents: o.refunded_cents,
    paymentProvider: o.payment_provider,
    events: o.events,
    items: o.items.map((i) => ({
      id: i.id, kind: i.kind, title: { en: i.title_en, ar: i.title_ar }, thumb: i.thumb, material: i.material, color: i.color, colorHex: i.color_hex,
      scale: i.scale, infill: i.infill, quantity: i.quantity, sizeMm: i.size_mm, weightGrams: i.weight_g, filamentCents: i.filament_cents,
      productSlug: i.product_id ? get('SELECT slug FROM products WHERE id = ?', i.product_id)?.slug : null,
      jobs: o.jobs.filter((j) => j.order_item_id === i.id).map((j) => ({ copy: j.copy_index, status: j.status, progress: Math.round(j.progress) })),
    })),
  };
}

export function registerStoreRoutes(r) {
  r.get('/api/health', () => ({ ok: true, name: 'Prompt2Print' }));

  r.get('/api/bootstrap', (req) => {
    const ctx = loadPricingContext();
    const o = ownerClause(req);
    const cartCount = get(`SELECT COALESCE(SUM(quantity), 0) AS n FROM cart_items WHERE ${o.sql}`, o.params).n;
    return {
      user: req.user,
      storeName: getSetting('store_name', 'Prompt2Print'),
      currency: ctx.currency,
      feeTiers: ctx.feeTiers,
      defaultCountry: getSetting('default_country', 'SA'),
      destination: destinationFrom(req, {}),
      display: (() => { const c = currencyFor(destinationFrom(req, {}).country); return { currency: c.code, rate: c.rate, decimals: c.decimals }; })(),
      countries: COUNTRIES,
      materials: materialsPublic(ctx),
      categories: categoriesPublic(),
      currencies: currencies(),
      infillRange: ctx.infillRange,
      maxModelMm: ctx.maxModelMm,
      cartCount,
      ai: { provider: activeProvider().id, label: activeProvider().label },
      payments: { provider: activePaymentProvider() },
      desktop: config.desktop,
      demo: config.demo,
      adminSetupNeeded: adminSetupNeeded() && LOOPBACK.has(clientIp(req)),
      adminEmail: adminSetupNeeded() && LOOPBACK.has(clientIp(req)) ? config.adminEmail : undefined,
    };
  });

  // Catalog ----------------------------------------------------------------------------------
  r.get('/api/categories', () => categoriesPublic());

  r.get('/api/products', (req) => {
    const q = req.query;
    const where = ['p.active = 1'];
    const params = [];
    if (q.category) {
      where.push('c.slug = ?');
      params.push(q.category);
    }
    if (q.featured) where.push('p.featured = 1');
    if (q.q) {
      const terms = String(q.q).trim().split(/\s+/).slice(0, 6);
      for (const t of terms) {
        where.push('(p.name_en LIKE ? OR p.name_ar LIKE ? OR p.desc_en LIKE ? OR p.desc_ar LIKE ? OR p.tags LIKE ? OR c.name_en LIKE ? OR c.name_ar LIKE ?)');
        const like = `%${t}%`;
        params.push(like, like, like, like, like, like, like);
      }
    }
    const rows = all(`SELECT p.* FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE ${where.join(' AND ')}`, params);
    const ctx = loadPricingContext();
    const dest = destinationFrom(req, q);
    let items = rows.map((p) => ({ ...productCard(p, ctx, dest), _created: p.created_at }));
    const price = (x) => x.price?.totalCents ?? Infinity;
    const sorters = {
      price_asc: (a, b) => price(a) - price(b),
      price_desc: (a, b) => price(b) - price(a),
      rating: (a, b) => b.rating - a.rating || b.ratingCount - a.ratingCount,
      newest: (a, b) => (a._created < b._created ? 1 : -1),
      bestselling: (a, b) => b.soldCount - a.soldCount,
      featured: (a, b) => Number(b.featured) - Number(a.featured) || b.soldCount - a.soldCount,
    };
    items.sort(sorters[q.sort] || sorters.featured);
    const limit = Math.min(60, Number(q.limit) || 24);
    const page = Math.max(1, Number(q.page) || 1);
    const total = items.length;
    items = items.slice((page - 1) * limit, page * limit).map(({ _created, ...rest }) => rest);
    return { items, total, page, pages: Math.ceil(total / limit), destination: dest };
  });

  r.get('/api/products/:slug', (req) => {
    const p = get('SELECT * FROM products WHERE slug = ? AND active = 1', req.params.slug);
    if (!p) throw notFound('This product is not available.');
    const model = getModel(p.model_id);
    const cat = p.category_id ? get('SELECT * FROM categories WHERE id = ?', p.category_id) : null;
    const ctx = loadPricingContext();
    const dest = destinationFrom(req, req.query);
    const related = all('SELECT * FROM products WHERE active = 1 AND category_id = ? AND id != ? ORDER BY sold_count DESC LIMIT 6', [p.category_id, p.id])
      .map((x) => productCard(x, ctx, dest));
    const inWishlist = req.user ? Boolean(get('SELECT 1 FROM wishlist WHERE user_id = ? AND product_id = ?', [req.user.id, p.id])) : false;
    const dist = all('SELECT rating, COUNT(*) AS n FROM reviews WHERE product_id = ? GROUP BY rating', p.id);
    return {
      ...productBase(p),
      description: { en: p.desc_en, ar: p.desc_ar },
      category: cat ? { slug: cat.slug, name: { en: cat.name_en, ar: cat.name_ar } } : null,
      modelId: p.model_id,
      analysis: publicAnalysis(model.analysis),
      defaults: { material: p.default_material, color: p.default_color, scale: p.default_scale, infill: p.default_infill },
      allowedMaterials: parseJson(p.allowed_materials, []),
      minScale: p.min_scale,
      maxScale: p.max_scale,
      inWishlist,
      ratingDistribution: Object.fromEntries(dist.map((d) => [d.rating, d.n])),
      related,
      destination: dest,
    };
  });

  r.get('/api/products/:slug/reviews', (req) => {
    const p = get('SELECT id FROM products WHERE slug = ?', req.params.slug);
    if (!p) throw notFound();
    return all('SELECT id, author_name, rating, title, body, locale, verified, created_at FROM reviews WHERE product_id = ? ORDER BY created_at DESC LIMIT 100', p.id);
  });

  r.post('/api/products/:slug/reviews', async (req) => {
    const user = requireUser(req);
    const p = get('SELECT id FROM products WHERE slug = ?', req.params.slug);
    if (!p) throw notFound();
    const b = await readJson(req);
    const rating = Math.round(Number(b.rating));
    if (!(rating >= 1 && rating <= 5)) throw bad('Choose a rating from 1 to 5 stars.');
    const body = String(b.body || '').trim().slice(0, 2000);
    if (body.length < 5) throw bad('Write a few words about the item.');
    if (get('SELECT 1 FROM reviews WHERE product_id = ? AND user_id = ?', [p.id, user.id])) throw bad('You have already reviewed this item.');
    const verified = get(`SELECT 1 FROM order_items i JOIN orders o ON o.id = i.order_id
      WHERE i.product_id = ? AND o.user_id = ? AND o.status IN ('delivered','shipped')`, [p.id, user.id]) ? 1 : 0;
    run('INSERT INTO reviews(product_id, user_id, author_name, rating, title, body, locale, verified) VALUES(?, ?, ?, ?, ?, ?, ?, ?)',
      [p.id, user.id, user.name, rating, String(b.title || '').slice(0, 120), body, user.locale || 'en', verified]);
    run('UPDATE products SET rating_avg = (SELECT AVG(rating) FROM reviews WHERE product_id = ?), rating_count = (SELECT COUNT(*) FROM reviews WHERE product_id = ?) WHERE id = ?', [p.id, p.id, p.id]);
    return { ok: true };
  });

  // Live price + printability for any combination of options.
  r.post('/api/quote', async (req) => {
    const b = await readJson(req);
    const ctx = loadPricingContext();
    let line;
    if (b.productSlug) {
      const p = get('SELECT * FROM products WHERE slug = ? AND active = 1', b.productSlug);
      if (!p) throw notFound();
      line = { ...defaultLine(p, getModel(p.model_id).analysis) };
    } else if (b.designId) {
      const d = get("SELECT * FROM designs WHERE id = ? AND status = 'ready'", b.designId);
      if (!d) throw notFound('Design not found.');
      const model = getModel(d.model_id);
      if (!userCanSeeModel(req, model)) throw notFound('Design not found.');
      line = { analysis: model.analysis };
    } else throw bad('Nothing to quote.');
    const priced = priceLine(ctx, {
      ...line, material: b.material, color: b.color, scale: b.scale, infill: b.infill, quantity: b.quantity || 1,
    });
    const q = quoteLines(ctx, [priced], destinationFrom(req, b));
    return {
      breakdown: q.breakdown, taxRate: q.taxRate, shipping: q.shipping, shipsToDestination: q.shipsToDestination,
      destination: q.destination, currency: q.currency, display: q.display,
      line: {
        sizeMm: priced.sizeMm, weightGrams: priced.weightGrams, unitWeightGrams: priced.unitWeightGrams, pricePerGram: priced.pricePerGram,
        materialName: priced.materialName, colorName: priced.colorName, colorHex: priced.colorHex,
      },
      printability: priced.printability,
    };
  });

  // Protected low-detail preview for the 3D viewer. Never the printable file.
  r.get('/api/models/:id/preview', (req, res) => {
    if (req.headers['x-p2p'] !== '1') throw notFound();
    const model = getModel(req.params.id);
    if (!userCanSeeModel(req, model)) throw notFound('Model not found.');
    const buf = previewBuffer(model.id);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store, private',
      'Content-Disposition': 'inline',
      'X-Robots-Tag': 'noindex',
    });
    res.end(buf);
  });

  // Accounts ---------------------------------------------------------------------------------
  r.post('/api/auth/signup', async (req, res) => {
    const b = await readJson(req);
    const name = String(b.name || '').trim().slice(0, 80);
    const email = String(b.email || '').trim().toLowerCase();
    const password = String(b.password || '');
    if (name.length < 2) throw bad('Enter your name.', 'name');
    if (!EMAIL_RX.test(email)) throw bad('Enter a valid email address.', 'email');
    if (password.length < 8) throw bad('Use at least 8 characters for your password.', 'password');
    if (get('SELECT 1 FROM users WHERE email = ?', email)) throw bad('An account with this email already exists. Sign in instead.', 'email_taken');
    const locale = b.locale === 'ar' ? 'ar' : 'en';
    checkLoginThrottle(clientIp(req), 'signup');
    const r2 = run('INSERT INTO users(email, name, password_hash, locale) VALUES(?, ?, ?, ?)', [email, name, await hashPasswordAsync(password), locale]);
    const id = Number(r2.lastInsertRowid);
    createSession(res, id);
    adoptGuestData(req.guestKey, id);
    return { user: { id, email, name, role: 'customer', locale } };
  });

  r.post('/api/auth/login', async (req, res) => {
    const b = await readJson(req);
    const email = String(b.email || '').trim().toLowerCase().slice(0, 200);
    const ip = clientIp(req);
    checkLoginThrottle(ip, email);
    const u = get('SELECT * FROM users WHERE email = ?', email);
    const ok = await verifyPasswordAsync(String(b.password || '').slice(0, 200), u?.password_hash);
    if (!u || !ok) {
      recordLoginFailure(ip, email);
      throw bad('Email or password is incorrect.', 'bad_login');
    }
    clearLoginFailures(email);
    if (u.role === 'admin') audit({ ...req, user: { id: u.id, email: u.email } }, 'admin.login');
    if (u.disabled) throw bad('This account is disabled. Contact support.', 'disabled');
    createSession(res, u.id);
    adoptGuestData(req.guestKey, u.id);
    return { user: { id: u.id, email: u.email, name: u.name, role: u.role, locale: u.locale } };
  });

  r.post('/api/auth/logout', (req, res) => { destroySession(req, res); return { ok: true }; });

  // First start: the admin account exists without a password. The owner sets it once, from the
  // computer the shop runs on (loopback only), after which this route is closed for good.
  r.post('/api/auth/setup-admin', async (req, res) => {
    if (!adminSetupNeeded()) throw bad('The admin password is already set.', 'already_set');
    const ip = clientIp(req);
    if (!LOOPBACK.has(ip)) throw unauthorized('The admin password can only be set from the computer that runs the shop.');
    const b = await readJson(req);
    const password = String(b.password || '');
    if (password.length < 10) throw bad('Use at least 10 characters.', 'weak_password');
    const admin = get("SELECT * FROM users WHERE role = 'admin' AND (password_hash = '' OR password_hash IS NULL) ORDER BY id LIMIT 1");
    run('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPasswordAsync(password), admin.id]);
    audit({ ...req, user: { id: admin.id, email: admin.email } }, 'admin.setup_password');
    createSession(res, admin.id);
    return { user: { id: admin.id, email: admin.email, name: admin.name, role: admin.role, locale: admin.locale } };
  });

  r.patch('/api/me', async (req) => {
    const user = requireUser(req);
    const b = await readJson(req);
    if (b.locale) run('UPDATE users SET locale = ? WHERE id = ?', [b.locale === 'ar' ? 'ar' : 'en', user.id]);
    if (b.name && String(b.name).trim().length >= 2) run('UPDATE users SET name = ? WHERE id = ?', [String(b.name).trim().slice(0, 80), user.id]);
    if (b.newPassword) {
      const u = get('SELECT password_hash FROM users WHERE id = ?', user.id);
      if (!(await verifyPasswordAsync(String(b.currentPassword || ''), u.password_hash))) throw bad('Your current password is incorrect.');
      if (String(b.newPassword).length < 8) throw bad('Use at least 8 characters for your new password.');
      run('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPasswordAsync(String(b.newPassword)), user.id]);
      // Sign out every other device.
      run('DELETE FROM sessions WHERE user_id = ? AND token != ?', [user.id, req.cookies?.p2p_session || '']);
    }
    return { ok: true };
  });

  // Addresses
  const addrFields = (b) => {
    const a = {
      label: String(b.label || '').slice(0, 40), full_name: String(b.fullName || '').trim().slice(0, 80), phone: String(b.phone || '').slice(0, 30),
      line1: String(b.line1 || '').trim().slice(0, 120), line2: String(b.line2 || '').slice(0, 120), city: String(b.city || '').trim().slice(0, 60),
      region: String(b.region || '').slice(0, 60), postal_code: String(b.postalCode || '').slice(0, 20), country: String(b.country || '').toUpperCase().slice(0, 2),
    };
    if (!a.full_name || !a.line1 || !a.city || !/^[A-Z]{2}$/.test(a.country)) throw bad('Fill in the name, street, city and country.', 'address_incomplete');
    return a;
  };
  const addrDTO = (a) => ({
    id: a.id, label: a.label, fullName: a.full_name, phone: a.phone, line1: a.line1, line2: a.line2, city: a.city, region: a.region,
    postalCode: a.postal_code, country: a.country, isDefault: Boolean(a.is_default),
  });
  r.get('/api/addresses', (req) => all('SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, id', requireUser(req).id).map(addrDTO));
  r.post('/api/addresses', async (req) => {
    const user = requireUser(req);
    const a = addrFields(await readJson(req));
    const first = !get('SELECT 1 FROM addresses WHERE user_id = ?', user.id);
    const res2 = run(`INSERT INTO addresses(user_id, label, full_name, phone, line1, line2, city, region, postal_code, country, is_default)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [user.id, a.label, a.full_name, a.phone, a.line1, a.line2, a.city, a.region, a.postal_code, a.country, first ? 1 : 0]);
    return addrDTO(get('SELECT * FROM addresses WHERE id = ?', Number(res2.lastInsertRowid)));
  });
  r.patch('/api/addresses/:id', async (req) => {
    const user = requireUser(req);
    const b = await readJson(req);
    const existing = get('SELECT * FROM addresses WHERE id = ? AND user_id = ?', [Number(req.params.id), user.id]);
    if (!existing) throw notFound();
    if (b.makeDefault) {
      run('UPDATE addresses SET is_default = 0 WHERE user_id = ?', user.id);
      run('UPDATE addresses SET is_default = 1 WHERE id = ?', existing.id);
    }
    if (b.line1 !== undefined) {
      const a = addrFields(b);
      run('UPDATE addresses SET label=?, full_name=?, phone=?, line1=?, line2=?, city=?, region=?, postal_code=?, country=? WHERE id = ?',
        [a.label, a.full_name, a.phone, a.line1, a.line2, a.city, a.region, a.postal_code, a.country, existing.id]);
    }
    return addrDTO(get('SELECT * FROM addresses WHERE id = ?', existing.id));
  });
  r.delete('/api/addresses/:id', (req) => {
    const user = requireUser(req);
    run('DELETE FROM addresses WHERE id = ? AND user_id = ?', [Number(req.params.id), user.id]);
    if (!get('SELECT 1 FROM addresses WHERE user_id = ? AND is_default = 1', user.id)) {
      run('UPDATE addresses SET is_default = 1 WHERE id = (SELECT id FROM addresses WHERE user_id = ? ORDER BY id LIMIT 1)', user.id);
    }
    return { ok: true };
  });

  // Wishlist
  r.get('/api/wishlist', (req) => {
    const user = requireUser(req);
    const ctx = loadPricingContext();
    const dest = destinationFrom(req, req.query);
    return all('SELECT p.* FROM wishlist w JOIN products p ON p.id = w.product_id WHERE w.user_id = ? AND p.active = 1 ORDER BY w.created_at DESC', user.id)
      .map((p) => productCard(p, ctx, dest));
  });
  r.post('/api/wishlist', async (req) => {
    const user = requireUser(req);
    const b = await readJson(req);
    const p = get('SELECT id FROM products WHERE id = ?', Number(b.productId));
    if (!p) throw notFound();
    run('INSERT OR IGNORE INTO wishlist(user_id, product_id) VALUES(?, ?)', [user.id, p.id]);
    return { ok: true };
  });
  r.delete('/api/wishlist/:productId', (req) => {
    run('DELETE FROM wishlist WHERE user_id = ? AND product_id = ?', [requireUser(req).id, Number(req.params.productId)]);
    return { ok: true };
  });

  // Cart -------------------------------------------------------------------------------------
  r.get('/api/cart', (req) => cartView(req, req.query));

  r.post('/api/cart/items', async (req) => {
    const b = await readJson(req);
    const ctx = loadPricingContext();
    let row;
    if (b.productSlug) {
      const p = get('SELECT * FROM products WHERE slug = ? AND active = 1', b.productSlug);
      if (!p) throw notFound('This product is not available.');
      const priced = priceLine(ctx, { ...defaultLine(p, getModel(p.model_id).analysis), material: b.material, color: b.color, scale: b.scale, infill: b.infill, quantity: b.quantity || 1 });
      if (!priced.printability.ok) throw bad('This size or material cannot be printed. Adjust the options.', 'not_printable');
      row = { kind: 'product', product_id: p.id, design_id: null, ...priced };
    } else if (b.designId) {
      const d = get("SELECT * FROM designs WHERE id = ? AND status = 'ready'", b.designId);
      const model = d && getModel(d.model_id);
      if (!d || !userCanSeeModel(req, model)) throw notFound('Design not found.');
      const priced = priceLine(ctx, { analysis: model.analysis, material: b.material, color: b.color, scale: b.scale, infill: b.infill, quantity: b.quantity || 1 });
      if (!priced.printability.ok) throw bad('This design cannot be printed with these settings. Check the printability list.', 'not_printable');
      row = { kind: 'design', product_id: null, design_id: d.id, ...priced };
    } else throw bad('Nothing to add.');
    run(`INSERT INTO cart_items(user_id, guest_key, kind, product_id, design_id, material, color, scale, infill, quantity) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.user?.id ?? null, req.user ? null : req.guestKey, row.kind, row.product_id, row.design_id, row.material, row.color, row.scale, row.infill, row.quantity]);
    return cartView(req, b);
  });

  r.patch('/api/cart/items/:id', async (req) => {
    const b = await readJson(req);
    const o = ownerClause(req);
    const item = get(`SELECT * FROM cart_items WHERE id = ? AND ${o.sql}`, [Number(req.params.id), ...o.params]);
    if (!item) throw notFound();
    const q = Math.round(Number(b.quantity));
    if (!(q >= 1 && q <= 50)) throw bad('Quantity must be between 1 and 50.');
    run('UPDATE cart_items SET quantity = ? WHERE id = ?', [q, item.id]);
    return cartView(req, b);
  });

  r.delete('/api/cart/items/:id', (req) => {
    const o = ownerClause(req);
    run(`DELETE FROM cart_items WHERE id = ? AND ${o.sql}`, [Number(req.params.id), ...o.params]);
    return cartView(req, req.query);
  });

  // AI designs -------------------------------------------------------------------------------
  r.post('/api/designs', async (req) => {
    const b = await readJson(req);
    let parentId = null;
    if (b.parentId) {
      const o = ownerClause(req);
      const parent = get(`SELECT id FROM designs WHERE id = ? AND ${o.sql}`, [b.parentId, ...o.params]);
      parentId = parent?.id || null;
    }
    const id = createDesign(req, { prompt: b.prompt, parentId, locale: b.locale === 'ar' ? 'ar' : 'en' });
    return designDTO(get('SELECT * FROM designs WHERE id = ?', id));
  });

  r.post('/api/designs/:id/regenerate', (req) => {
    const o = ownerClause(req);
    const d = get(`SELECT * FROM designs WHERE id = ? AND ${o.sql}`, [req.params.id, ...o.params]);
    if (!d) throw notFound('Design not found.');
    const id = createDesign(req, { prompt: d.prompt, parentId: d.id });
    return designDTO(get('SELECT * FROM designs WHERE id = ?', id));
  });

  r.get('/api/designs', (req) => {
    const o = ownerClause(req);
    return all(`SELECT * FROM designs WHERE ${o.sql} ORDER BY created_at DESC LIMIT 40`, o.params).map(designDTO);
  });

  r.get('/api/designs/:id', (req) => {
    const o = ownerClause(req);
    const d = get(`SELECT * FROM designs WHERE id = ? AND ${o.sql}`, [req.params.id, ...o.params]);
    if (!d) throw notFound('Design not found.');
    return designDTO(d);
  });

  // Checkout & payment -----------------------------------------------------------------------
  r.post('/api/checkout', async (req) => {
    const user = requireUser(req);
    requirePayments();
    const b = await readJson(req);
    const a = get('SELECT * FROM addresses WHERE id = ? AND user_id = ?', [Number(b.addressId), user.id]);
    if (!a) throw bad('Choose a delivery address.', 'address_required');
    const address = { fullName: a.full_name, phone: a.phone, line1: a.line1, line2: a.line2, city: a.city, region: a.region, postalCode: a.postal_code, country: a.country };
    const order = createOrderFromCart(user, address);
    return { number: order.number, totalCents: order.total_cents, provider: activePaymentProvider() };
  });

  const ownOrder = (req) => {
    const user = requireUser(req);
    const o = getOrderByNumber(req.params.number);
    if (!o || (o.user_id !== user.id && user.role !== 'admin')) throw notFound('Order not found.');
    return o;
  };

  r.post('/api/orders/:number/pay/test', async (req) => {
    const o = ownOrder(req);
    if (o.status !== 'pending_payment') throw bad('This order is already paid.');
    const b = await readJson(req);
    const paid = payWithTestCard(o, b.card);
    return orderSummary(paid, { full: true });
  });

  r.post('/api/orders/:number/pay/stripe', async (req) => {
    const o = ownOrder(req);
    if (o.status !== 'pending_payment') throw bad('This order is already paid.');
    const origin = config.publicUrl || `http://${req.headers.host}`;
    return { redirectUrl: await createStripeCheckout(o, origin) };
  });

  r.post('/api/orders/:number/confirm', async (req) => {
    const o = ownOrder(req);
    const b = await readJson(req);
    if (b.sessionId) return orderSummary(await confirmStripeSession(o, b.sessionId), { full: true });
    return orderSummary(await confirmTapPayment(o, b.tapId), { full: true });
  });

  r.post('/api/orders/:number/pay/tap', async (req) => {
    const o = ownOrder(req);
    if (o.status !== 'pending_payment') throw bad('This order is already paid.');
    const origin = config.publicUrl || `http://${req.headers.host}`;
    const user = req.user;
    return { redirectUrl: await createTapPayment(o, origin, { name: o.address.fullName || user.name, email: user.email, phone: o.address.phone }) };
  });

  r.post('/api/payments/tap/webhook', async (req) => {
    const body = await readJson(req);
    return handleTapWebhook(body, req.headers.hashstring);
  });

  r.post('/api/payments/stripe/webhook', async (req) => {
    const raw = (await readBody(req, 1024 * 1024)).toString('utf8');
    return handleStripeWebhook(raw, req.headers['stripe-signature']);
  });

  // Orders -----------------------------------------------------------------------------------
  r.get('/api/orders', (req) => {
    const user = requireUser(req);
    return all('SELECT number FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 100', user.id)
      .map((row) => orderSummary(getOrderByNumber(row.number)));
  });

  r.get('/api/orders/:number', (req) => orderSummary(ownOrder(req), { full: true }));

  r.get('/api/designs-thumb-check', () => { throw new HttpError(410, 'gone'); });
}

export { unauthorized };
