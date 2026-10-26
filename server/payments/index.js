// Payment providers.
//  test   – built-in test mode: accepts test card numbers, no real money moves.
//  stripe – Stripe Checkout (hosted payment page) via Stripe's REST API.
// Printing starts only when a provider confirms payment and calls markPaid().

import crypto from 'node:crypto';
import { getSetting, get, run } from '../db.js';
import { markPaid, recordFailedPayment, getOrderById } from '../orders.js';
import { bad } from '../lib/http.js';
import { config } from '../config.js';
import { decryptSecret } from '../lib/secrets.js';
import { createTapCharge, retrieveTapCharge, tapChargePaid, tapChargeFailed, verifyTapWebhook, createTapRefund, amountToMinor } from './tap.js';

// 'stripe', 'test', or 'unconfigured'. There is no silent fallback: if Stripe is chosen without a
// key, payments are refused. Test cards only work in demo mode (or with P2P_ALLOW_TEST_PAYMENTS=1).
function tapKey() { return decryptSecret(getSetting('tap_secret_key', '')) || process.env.TAP_SECRET_KEY || ''; }

export function activePaymentProvider() {
  const chosen = getSetting('payment_provider', process.env.PAYMENT_PROVIDER || 'tap');
  if (chosen === 'tap') return tapKey() ? 'tap' : 'unconfigured';
  if (chosen === 'stripe') return stripeKey() ? 'stripe' : 'unconfigured';
  if (chosen === 'test') return config.demo || process.env.P2P_ALLOW_TEST_PAYMENTS === '1' ? 'test' : 'unconfigured';
  return 'unconfigured';
}

export function requirePayments() {
  if (activePaymentProvider() === 'unconfigured') {
    throw bad("Payments aren't set up yet, so orders can't be placed. The shop owner needs to finish the payment settings.", 'payments_unconfigured');
  }
}

// Test mode ------------------------------------------------------------------------------------
export function luhnValid(number) {
  const digits = String(number).replace(/\D/g, '');
  if (digits.length < 12 || digits.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

export function payWithTestCard(order, card) {
  if (activePaymentProvider() !== 'test') throw bad('Test payments are turned off.', 'test_disabled');
  const number = String(card?.number || '').replace(/\D/g, '');
  const [mm, yy] = String(card?.expiry || '').split('/').map((s) => parseInt(s, 10));
  if (!luhnValid(number)) throw bad('That card number is not valid.', 'card_invalid');
  if (!(mm >= 1 && mm <= 12) || !(yy >= 0)) throw bad('Enter the expiry date as MM/YY.', 'card_expiry');
  const exp = new Date(2000 + yy, mm, 1);
  if (exp < new Date()) throw bad('This card has expired.', 'card_expired');
  if (!/^\d{3,4}$/.test(String(card?.cvc || ''))) throw bad('Enter the 3 or 4 digit security code.', 'card_cvc');
  if (number === '4000000000000002') {
    recordFailedPayment(order.id, 'test', 'Card declined');
    throw bad('The card was declined. Try another card.', 'card_declined');
  }
  const ref = `test_${crypto.randomBytes(8).toString('hex')}`;
  return markPaid(order.id, { provider: 'test', ref, amountCents: order.total_cents, detail: { last4: number.slice(-4) } });
}

// Stripe ---------------------------------------------------------------------------------------
function stripeKey() { return decryptSecret(getSetting('stripe_secret_key', '')) || process.env.STRIPE_SECRET_KEY || ''; }
function stripeWebhookSecret() { return decryptSecret(getSetting('stripe_webhook_secret', '')) || process.env.STRIPE_WEBHOOK_SECRET || ''; }

async function stripe(method, path, params) {
  const body = params ? new URLSearchParams(flatten(params)).toString() : undefined;
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${stripeKey()}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json();
  if (!res.ok) throw bad(`Stripe: ${json.error?.message || res.status}`, 'stripe_error');
  return json;
}

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v !== null && typeof v === 'object') flatten(v, key, out);
    else if (v !== undefined) out[key] = String(v);
  }
  return out;
}

export async function createStripeCheckout(order, origin) {
  if (activePaymentProvider() !== 'stripe') throw bad('Stripe payments are not set up.', 'stripe_disabled');
  // Reuse a still-open session so a customer can't be charged twice for one order.
  if (order.payment_provider === 'stripe' && String(order.payment_ref || '').startsWith('cs_')) {
    const existing = await stripe('GET', `/checkout/sessions/${encodeURIComponent(order.payment_ref)}`).catch(() => null);
    if (existing?.status === 'open' && existing.url) return existing.url;
  }
  const base = config.publicUrl || origin;
  const session = await stripe('POST', '/checkout/sessions', {
    mode: 'payment',
    client_reference_id: order.number,
    metadata: { order_number: order.number },
    payment_intent_data: { metadata: { order_number: order.number } },
    line_items: {
      0: {
        quantity: 1,
        price_data: {
          currency: order.currency.toLowerCase(),
          unit_amount: order.total_cents,
          product_data: { name: `Prompt2Print order ${order.number}` },
        },
      },
    },
    success_url: `${base}/orders/${order.number}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/orders/${order.number}?cancelled=1`,
  });
  run('UPDATE orders SET payment_provider = ?, payment_ref = ? WHERE id = ?', ['stripe', session.id, order.id]);
  return session.url;
}

// Confirm by asking Stripe directly (works on a local PC where webhooks can't reach us).
export async function confirmStripeSession(order, sessionId) {
  if (!sessionId || order.status !== 'pending_payment') return getOrderById(order.id);
  const s = await stripe('GET', `/checkout/sessions/${encodeURIComponent(sessionId)}`);
  if (s.client_reference_id !== order.number) throw bad('Payment session does not match this order.', 'session_mismatch');
  if (s.payment_status === 'paid') {
    return markPaid(order.id, { provider: 'stripe', ref: s.payment_intent || s.id, amountCents: s.amount_total });
  }
  return getOrderById(order.id);
}

export function verifyStripeSignature(rawBody, header, secret = stripeWebhookSecret(), toleranceSec = 300) {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=')));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const signatures = header.split(',').filter((kv) => kv.startsWith('v1=')).map((kv) => kv.slice(3));
  return signatures.some((sig) => sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)));
}

export function handleStripeWebhook(rawBody, signature) {
  if (!verifyStripeSignature(rawBody, signature)) throw bad('Invalid Stripe signature.', 'bad_signature');
  const event = JSON.parse(rawBody);
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const s = event.data.object;
    const order = get('SELECT * FROM orders WHERE number = ?', s.client_reference_id || s.metadata?.order_number);
    if (order && s.payment_status === 'paid') {
      markPaid(order.id, { provider: 'stripe', ref: s.payment_intent || s.id, amountCents: s.amount_total });
    }
  }
  return { received: true };
}

// Tap Payments (international Visa/Mastercard/Amex, Apple Pay, mada) ---------------------------------
export async function createTapPayment(order, origin, customer) {
  if (activePaymentProvider() !== 'tap') throw bad('Card payments are not set up.', 'tap_disabled');
  const base = config.publicUrl || origin;
  const currency = order.display_currency || order.currency;
  const amount = order.display_currency ? Number(order.charged_amount) : order.total_cents / 100;
  const { chargeId, redirectUrl } = await createTapCharge({
    order,
    amountMinor: amountToMinor(amount, currency),
    currency,
    customer,
    redirectUrl: `${base}/orders/${order.number}?tap_return=1`,
    postUrl: config.publicUrl ? `${config.publicUrl}/api/payments/tap/webhook` : undefined,
    secretKey: tapKey(),
    description: `Prompt2Print order ${order.number}`,
  });
  run('UPDATE orders SET payment_provider = ?, payment_ref = ? WHERE id = ?', ['tap', chargeId, order.id]);
  return redirectUrl;
}

// Confirm by asking Tap directly (the customer just came back from the payment page).
export async function confirmTapPayment(order, tapId) {
  if (order.status !== 'pending_payment') return getOrderById(order.id);
  const chargeId = tapId || order.payment_ref;
  if (!chargeId || !String(chargeId).startsWith('chg_')) return getOrderById(order.id);
  const charge = await retrieveTapCharge(chargeId, tapKey());
  const ref = charge.reference?.order || charge.metadata?.order_number;
  if (ref && ref !== order.number) throw bad('Payment does not match this order.', 'charge_mismatch');
  if (tapChargePaid(charge)) {
    return markPaid(order.id, { provider: 'tap', ref: charge.id, charged: { amount: charge.amount, currency: charge.currency }, detail: { status: charge.status, card: charge.card?.last_four } });
  }
  if (tapChargeFailed(charge)) recordFailedPayment(order.id, 'tap', `${charge.status}: ${charge.response?.message || ''}`);
  return getOrderById(order.id);
}

export function handleTapWebhook(body, hashstring) {
  if (!verifyTapWebhook(body, hashstring, tapKey())) throw bad('Invalid Tap signature.', 'bad_signature');
  const number = body.reference?.order || body.metadata?.order_number;
  const order = number && get('SELECT * FROM orders WHERE number = ?', number);
  if (order && tapChargePaid(body)) {
    markPaid(order.id, { provider: 'tap', ref: body.id, charged: { amount: body.amount, currency: body.currency }, detail: { status: body.status } });
  }
  return { received: true };
}

export async function refundPayment(order, amountCents) {
  if (order.payment_provider === 'tap') {
    const currency = order.display_currency || order.currency;
    const rate = order.display_currency ? Number(order.fx_rate) : 1;
    const amount = Math.round((amountCents / 100) * rate * 1000) / 1000;
    const r = await createTapRefund({ chargeId: order.payment_ref, amountMinor: amountToMinor(amount, currency), currency, secretKey: tapKey() });
    return r.refundId;
  }
  if (order.payment_provider === 'stripe') {
    const r = await stripe('POST', '/refunds', { payment_intent: order.payment_ref, amount: amountCents });
    return r.id;
  }
  return `test_refund_${crypto.randomBytes(6).toString('hex')}`;
}
