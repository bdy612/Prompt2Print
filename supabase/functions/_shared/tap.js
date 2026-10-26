// Tap Payments (https://developers.tap.company): international Visa/Mastercard/Amex, mada,
// Apple Pay, multi-currency, licensed in Saudi Arabia and the GCC.
//
// Flow: createTapCharge() → redirect the customer to Tap's hosted page (transaction.url) →
// Tap redirects back to redirectUrl with ?tap_id=chg_… and POSTs the charge to postUrl →
// retrieveTapCharge() / verifyTapWebhook() confirm the payment → markPaid().
//
// Tap amounts are decimal currency units (12.50), not minor units; this module converts.

import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';

export const TAP_API = 'https://api.tap.company/v2';

// Decimal places per currency (Tap rounds amounts to these).
const THREE_DECIMALS = new Set(['BHD', 'KWD', 'OMR', 'JOD', 'IQD', 'LYD', 'TND']);
const ZERO_DECIMALS = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'HUF', 'XAF', 'XOF']);

export function currencyDecimals(currency) {
  const c = String(currency || '').toUpperCase();
  if (THREE_DECIMALS.has(c)) return 3;
  if (ZERO_DECIMALS.has(c)) return 0;
  return 2;
}

// Minor units (cents/fils) → Tap decimal amount as a number.
export function tapMinorToAmount(minor, currency) {
  const d = currencyDecimals(currency);
  return Number((Number(minor) / 10 ** d).toFixed(d));
}

// Tap decimal amount → minor units (integer).
export function amountToMinor(amount, currency) {
  const d = currencyDecimals(currency);
  return Math.round(Number(amount) * 10 ** d);
}

// Amount formatted the way Tap's hashstring expects: fixed decimals for the currency.
export function formatTapAmount(amount, currency) {
  return Number(amount).toFixed(currencyDecimals(currency));
}

async function tapRequest(method, path, secretKey, body) {
  if (!secretKey) throw new Error('Tap secret key is not set.');
  const res = await fetch(`${TAP_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) {
    const detail = json?.errors?.map?.((e) => e.description || e.code).join('; ') || json?.message || json?.error || text || res.statusText;
    throw new Error(`Tap: ${detail} (HTTP ${res.status})`);
  }
  return json;
}

// Split "Abdulrahman Al Saud" into first / last names (Tap wants first_name at least).
function splitName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first_name: 'Customer' };
  const first = parts[0];
  const last = parts.slice(1).join(' ');
  return last ? { first_name: first, last_name: last } : { first_name: first };
}

// "+966 50 123 4567" → { country_code: '966', number: '501234567' }
function parsePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  if (String(phone).trim().startsWith('+') || String(phone).trim().startsWith('00')) {
    const d = digits.replace(/^00/, '');
    for (const len of [3, 2, 1]) {
      const cc = d.slice(0, len);
      const rest = d.slice(len);
      if (rest.length >= 6) return { country_code: cc, number: rest };
    }
  }
  if (digits.startsWith('0') && digits.length >= 9) return { country_code: '966', number: digits.replace(/^0/, '') };
  return { country_code: '966', number: digits };
}

/**
 * Create a hosted-page charge. Returns { chargeId, redirectUrl, raw }.
 * order: { number }, amountMinor: integer in minor units, currency: 'SAR' etc.
 */
export async function createTapCharge({
  order, amountMinor, currency, customer = {}, redirectUrl, postUrl, secretKey, description, source = 'src_all', metadata = {},
}) {
  if (!order?.number) throw new Error('Order number is required.');
  if (!(Number(amountMinor) > 0)) throw new Error('Amount must be positive.');
  if (!redirectUrl) throw new Error('Redirect URL is required.');
  const cur = String(currency || 'SAR').toUpperCase();
  const phone = parsePhone(customer.phone);
  const body = {
    amount: tapMinorToAmount(amountMinor, cur),
    currency: cur,
    customer_initiated: true,
    threeDSecure: true,
    save_card: false,
    description: description || `Prompt2Print order ${order.number}`,
    metadata: { order_number: order.number, ...metadata },
    reference: { transaction: `txn_${order.number}_${Date.now()}`, order: String(order.number) },
    customer: {
      ...splitName(customer.name),
      ...(customer.email ? { email: customer.email } : {}),
      ...(phone ? { phone } : {}),
    },
    source: { id: source },
    redirect: { url: redirectUrl },
    ...(postUrl ? { post: { url: postUrl } } : {}),
  };
  const charge = await tapRequest('POST', '/charges', secretKey, body);
  const url = charge?.transaction?.url;
  if (!charge?.id || !url) throw new Error('Tap did not return a payment page.');
  return { chargeId: charge.id, redirectUrl: url, raw: charge };
}

export async function retrieveTapCharge(chargeId, secretKey) {
  if (!/^chg_[\w-]+$/i.test(String(chargeId || ''))) throw new Error('Invalid Tap charge id.');
  return tapRequest('GET', `/charges/${encodeURIComponent(chargeId)}`, secretKey);
}

// Only CAPTURED means the money was taken. (AUTHORIZED is for the separate Authorize API,
// which this shop does not use; everything else is pending or failed.)
const PAID_STATUSES = new Set(['CAPTURED']);
export function tapChargePaid(charge) {
  return PAID_STATUSES.has(String(charge?.status || '').toUpperCase());
}

export function tapChargeFailed(charge) {
  return ['ABANDONED', 'CANCELLED', 'FAILED', 'DECLINED', 'RESTRICTED', 'VOID', 'TIMEDOUT', 'UNKNOWN']
    .includes(String(charge?.status || '').toUpperCase());
}

/**
 * Hashstring for a charge/authorize/refund webhook, as documented by Tap:
 *   "x_id{id}x_amount{amount}x_currency{currency}x_gateway_reference{gw}x_payment_reference{pay}x_status{status}x_created{created}"
 * amount formatted with the currency's decimals, HMAC-SHA256 with the secret API key, hex.
 */
export function tapHashString(body) {
  const id = body?.id ?? '';
  const amount = formatTapAmount(body?.amount ?? 0, body?.currency);
  const currency = body?.currency ?? '';
  const gateway = body?.reference?.gateway ?? '';
  const payment = body?.reference?.payment ?? '';
  const status = body?.status ?? '';
  const created = body?.transaction?.created ?? body?.created ?? '';
  return `x_id${id}x_amount${amount}x_currency${currency}x_gateway_reference${gateway}x_payment_reference${payment}x_status${status}x_created${created}`;
}

export function computeTapHash(body, secretKey) {
  return crypto.createHmac('sha256', String(secretKey)).update(tapHashString(body)).digest('hex');
}

export function verifyTapWebhook(body, headerHashstring, secretKey) {
  if (!body || !headerHashstring || !secretKey) return false;
  const expected = computeTapHash(body, secretKey);
  const given = String(headerHashstring).trim().toLowerCase();
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given, 'utf8'), Buffer.from(expected, 'utf8'));
}

/**
 * Refund a captured charge (full or partial). reason: duplicate | fraudulent | requested_by_customer.
 * Returns { refundId, status, raw }.
 */
export async function createTapRefund({ chargeId, amountMinor, currency, reason = 'requested_by_customer', secretKey, metadata = {}, postUrl }) {
  const allowed = ['duplicate', 'fraudulent', 'requested_by_customer'];
  const cur = String(currency || 'SAR').toUpperCase();
  const body = {
    charge_id: chargeId,
    amount: tapMinorToAmount(amountMinor, cur),
    currency: cur,
    reason: allowed.includes(reason) ? reason : 'requested_by_customer',
    metadata,
    ...(postUrl ? { post: { url: postUrl } } : {}),
  };
  const refund = await tapRequest('POST', '/refunds', secretKey, body);
  if (!refund?.id) throw new Error('Tap did not return a refund id.');
  return { refundId: refund.id, status: refund.status, raw: refund };
}
