// Orders: created from the cart at checkout, paid through a payment provider, then printed.
// Printing is only ever started from markPaid(), so nothing prints before payment is confirmed.

import crypto from 'node:crypto';
import { all, get, run, tx, parseJson } from './db.js';
import { loadPricingContext, priceLine, quoteLines } from './pricing/quote.js';
import { getModel } from './models.js';
import { bad, notFound } from './lib/http.js';
import { enqueueOrder, cancelOrderJobs } from './printing/queue.js';

export const ORDER_FLOW = ['paid', 'in_queue', 'printing', 'printed', 'packed', 'shipped', 'delivered'];

export function addEvent(orderId, status, note = null) {
  run('INSERT INTO order_events(order_id, status, note) VALUES(?, ?, ?)', [orderId, status, note]);
}

export function setStatus(orderId, status, note = null) {
  run("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?", [status, orderId]);
  addEvent(orderId, status, note);
}

// Turn cart rows into priced lines. Shared by the cart page and checkout.
export function priceCartRows(ctx, rows) {
  const lines = [];
  const problems = [];
  for (const row of rows) {
    try {
      let analysis, extra, info;
      if (row.kind === 'product') {
        const p = get('SELECT * FROM products WHERE id = ? AND active = 1', row.product_id);
        if (!p) throw bad('This product is no longer available.', 'unavailable');
        analysis = getModel(p.model_id).analysis;
        extra = { allowedMaterials: parseJson(p.allowed_materials, []), minScale: p.min_scale, maxScale: p.max_scale };
        info = { titleEn: p.name_en, titleAr: p.name_ar, thumb: parseJson(p.images, [])[0] || null, slug: p.slug, modelId: p.model_id, productId: p.id };
      } else {
        const d = get("SELECT * FROM designs WHERE id = ? AND status = 'ready'", row.design_id);
        if (!d) throw bad('This design is not ready.', 'unavailable');
        analysis = getModel(d.model_id).analysis;
        extra = {};
        info = { titleEn: d.title_en, titleAr: d.title_ar, thumb: d.thumb, modelId: d.model_id, designId: d.id };
      }
      const priced = priceLine(ctx, {
        analysis, material: row.material, color: row.color, scale: row.scale, infill: row.infill, quantity: row.quantity, ...extra,
      });
      lines.push({ ...priced, cartItemId: row.id, kind: row.kind, ...info });
    } catch (err) {
      problems.push({ cartItemId: row.id, message: err.message });
    }
  }
  return { lines, problems };
}

function newOrderNumber() {
  for (;;) {
    const n = `P2P-${crypto.randomInt(100000, 999999)}`;
    if (!get('SELECT 1 FROM orders WHERE number = ?', n)) return n;
  }
}

export function createOrderFromCart(user, address) {
  const rows = all('SELECT * FROM cart_items WHERE user_id = ? ORDER BY id', user.id);
  if (!rows.length) throw bad('Your cart is empty.', 'empty_cart');
  const ctx = loadPricingContext();
  const { lines, problems } = priceCartRows(ctx, rows);
  if (problems.length) throw bad(`Fix your cart first: ${problems[0].message}`, 'cart_problem', { problems });
  const quote = quoteLines(ctx, lines, { country: address.country, region: address.region });
  if (!quote.shipsToDestination) throw bad(`We don't ship to ${address.country} yet.`, 'no_shipping');
  const blocked = lines.find((l) => !l.printability.ok);
  if (blocked) throw bad(`"${blocked.titleEn}" can't be printed at this size: ${blocked.printability.checks.find((c) => c.status === 'fail')?.detail}`, 'not_printable');

  const number = newOrderNumber();
  const pricing = { ...quote.breakdown, taxRate: quote.taxRate, shipping: quote.shipping, currency: quote.currency, display: quote.display };
  return tx(() => {
    const r = run(
      `INSERT INTO orders(number, user_id, status, address, pricing, total_cents, currency, display_currency, fx_rate, charged_amount)
       VALUES(?, ?, 'pending_payment', ?, ?, ?, ?, ?, ?, ?)`,
      [number, user.id, JSON.stringify(address), JSON.stringify(pricing), quote.breakdown.totalCents, quote.currency,
        quote.display.currency, quote.display.rate, quote.display.total]);
    const orderId = Number(r.lastInsertRowid);
    for (const l of lines) {
      run(`INSERT INTO order_items(order_id, kind, product_id, design_id, model_id, title_en, title_ar, thumb, material, color, color_hex,
             scale, infill, quantity, size_mm, weight_g, needs_supports, filament_cents, tax_cents)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [orderId, l.kind, l.productId ?? null, l.designId ?? null, l.modelId, l.titleEn, l.titleAr, l.thumb, l.material, l.color, l.colorHex,
        l.scale, l.infill, l.quantity, JSON.stringify(l.sizeMm), l.weightGrams, l.printability.needsSupports ? 1 : 0,
        l.filamentCents, Math.round(l.filamentCents * (quote.taxRate.rate / 100))]);
    }
    addEvent(orderId, 'pending_payment');
    run('DELETE FROM cart_items WHERE user_id = ?', user.id);
    return getOrderById(orderId);
  });
}

export function getOrderById(id) {
  const o = get('SELECT * FROM orders WHERE id = ?', id);
  return o ? hydrate(o) : null;
}

export function getOrderByNumber(number) {
  const o = get('SELECT * FROM orders WHERE number = ?', number);
  return o ? hydrate(o) : null;
}

function hydrate(o) {
  const items = all('SELECT * FROM order_items WHERE order_id = ? ORDER BY id', o.id).map((i) => ({ ...i, size_mm: parseJson(i.size_mm) }));
  const events = all('SELECT status, note, created_at FROM order_events WHERE order_id = ? ORDER BY id', o.id);
  const jobs = all('SELECT id, order_item_id, copy_index, status, progress, printer_id, started_at, finished_at FROM print_jobs WHERE order_id = ? ORDER BY id', o.id);
  return { ...o, address: parseJson(o.address), pricing: parseJson(o.pricing), items, events, jobs };
}

/**
 * Called by a payment provider once the money is confirmed. Idempotent.
 * This is the only place that starts printing.
 */
export function markPaid(orderId, { provider, ref, amountCents, charged = null, detail = null }) {
  const order = get('SELECT * FROM orders WHERE id = ?', orderId);
  if (!order) throw notFound('Order not found.');
  // A charge made in the customer's currency must match what we asked for, to the smallest unit.
  if (charged) {
    const sameCurrency = String(charged.currency).toUpperCase() === String(order.display_currency || order.currency).toUpperCase();
    const expected = order.display_currency ? Number(order.charged_amount) : order.total_cents / 100;
    if (!sameCurrency || Math.abs(Number(charged.amount) - expected) > 0.0051) {
      throw bad('Payment amount does not match the order total.', 'amount_mismatch');
    }
    amountCents = order.total_cents;
  }
  if (order.status !== 'pending_payment') {
    // Already paid with this payment: nothing to do. A different payment (a second checkout, or a
    // payment that arrived after the order was cancelled) is recorded and flagged for a refund.
    const known = get("SELECT 1 FROM payments WHERE order_id = ? AND provider_ref = ? AND status = 'succeeded'", [orderId, ref]);
    if (!known && ref !== order.payment_ref) {
      run("INSERT INTO payments(order_id, provider, provider_ref, amount_cents, status, detail) VALUES(?, ?, ?, ?, 'succeeded', ?)",
        [orderId, provider, ref, amountCents, JSON.stringify({ unexpected: true, orderStatus: order.status })]);
      addEvent(orderId, order.status, `Extra payment received (${provider} ${ref}, $${(amountCents / 100).toFixed(2)}). Refund it.`);
      console.warn(`[payments] unexpected payment ${ref} for order ${order.number} (${order.status})`);
    }
    return getOrderById(orderId);
  }
  if (amountCents !== order.total_cents) throw bad('Payment amount does not match the order total.', 'amount_mismatch');
  tx(() => {
    run("UPDATE orders SET status = 'paid', paid_at = datetime('now'), payment_provider = ?, payment_ref = ?, updated_at = datetime('now') WHERE id = ?",
      [provider, ref, orderId]);
    run("INSERT INTO payments(order_id, provider, provider_ref, amount_cents, status, detail) VALUES(?, ?, ?, ?, 'succeeded', ?)",
      [orderId, provider, ref, amountCents, detail ? JSON.stringify(detail) : null]);
    addEvent(orderId, 'paid');
    for (const it of all("SELECT product_id, quantity FROM order_items WHERE order_id = ? AND kind = 'product'", orderId)) {
      run('UPDATE products SET sold_count = sold_count + ? WHERE id = ?', [it.quantity, it.product_id]);
    }
  });
  enqueueOrder(orderId);
  return getOrderById(orderId);
}

export function recordFailedPayment(orderId, provider, message) {
  run("INSERT INTO payments(order_id, provider, amount_cents, status, detail) SELECT id, ?, total_cents, 'failed', ? FROM orders WHERE id = ?",
    [provider, JSON.stringify({ message }), orderId]);
}

// Manual fulfilment steps done by staff after printing.
const NEXT = { printed: 'packed', packed: 'shipped', shipped: 'delivered' };

export function advanceFulfilment(orderId, target, { carrier, trackingNumber, note } = {}) {
  const o = get('SELECT * FROM orders WHERE id = ?', orderId);
  if (!o) throw notFound('Order not found.');
  if (NEXT[o.status] !== target) throw bad(`An order that is "${o.status}" can't move to "${target}".`, 'bad_transition');
  if (target === 'shipped') {
    if (!trackingNumber) throw bad('Enter the tracking number before marking as shipped.', 'tracking_required');
    run('UPDATE orders SET carrier = ?, tracking_number = ? WHERE id = ?', [carrier || null, trackingNumber, orderId]);
  }
  setStatus(orderId, target, note || (target === 'shipped' ? `${carrier || 'Carrier'} ${trackingNumber}` : null));
  return getOrderById(orderId);
}

export function cancelOrder(orderId, note) {
  const o = get('SELECT * FROM orders WHERE id = ?', orderId);
  if (!o) throw notFound('Order not found.');
  if (['shipped', 'delivered', 'cancelled', 'refunded'].includes(o.status)) throw bad(`A ${o.status} order can't be cancelled.`, 'bad_transition');
  cancelOrderJobs(orderId);
  setStatus(orderId, 'cancelled', note);
  return getOrderById(orderId);
}
