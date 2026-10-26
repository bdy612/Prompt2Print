import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  TAP_API, createTapCharge, retrieveTapCharge, tapChargePaid, tapChargeFailed, verifyTapWebhook, tapHashString,
  createTapRefund, tapMinorToAmount, amountToMinor, formatTapAmount, currencyDecimals,
} from '../server/payments/tap.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const r = handler(url, init);
    return new Response(JSON.stringify(r.body), { status: r.status || 200, headers: { 'Content-Type': 'application/json' } });
  };
  return calls;
}

test('amount conversion per currency decimals', () => {
  assert.equal(currencyDecimals('SAR'), 2);
  assert.equal(currencyDecimals('KWD'), 3);
  assert.equal(currencyDecimals('JPY'), 0);
  assert.equal(tapMinorToAmount(1317, 'SAR'), 13.17);
  assert.equal(tapMinorToAmount(12345, 'KWD'), 12.345);
  assert.equal(tapMinorToAmount(1500, 'JPY'), 1500);
  assert.equal(amountToMinor(13.17, 'USD'), 1317);
  assert.equal(amountToMinor(12.345, 'BHD'), 12345);
  assert.equal(amountToMinor(1500, 'JPY'), 1500);
  assert.equal(formatTapAmount(12.5, 'SAR'), '12.50');
  assert.equal(formatTapAmount(12.5, 'OMR'), '12.500');
  assert.equal(formatTapAmount(12.5, 'JPY'), '13');
});

test('tapChargePaid / tapChargeFailed per status', () => {
  assert.equal(tapChargePaid({ status: 'CAPTURED' }), true);
  assert.equal(tapChargePaid({ status: 'captured' }), true);
  for (const s of ['INITIATED', 'ABANDONED', 'CANCELLED', 'FAILED', 'DECLINED', 'RESTRICTED', 'VOID', 'TIMEDOUT', 'UNKNOWN', 'AUTHORIZED', '']) {
    assert.equal(tapChargePaid({ status: s }), false, s);
  }
  assert.equal(tapChargeFailed({ status: 'DECLINED' }), true);
  assert.equal(tapChargeFailed({ status: 'INITIATED' }), false);
  assert.equal(tapChargeFailed({ status: 'CAPTURED' }), false);
  assert.equal(tapChargePaid(null), false);
});

test('webhook hashstring follows Tap formula and verifies', () => {
  const secret = 'example-webhook-secret-not-a-real-key';
  const body = {
    id: 'chg_TS02A5420251325Kb8r0107123',
    amount: 13.1,
    currency: 'SAR',
    status: 'CAPTURED',
    reference: { gateway: 'GW-123', payment: 'PAY-456' },
    transaction: { created: '1729857600000' },
  };
  const expectedString = 'x_idchg_TS02A5420251325Kb8r0107123x_amount13.10x_currencySARx_gateway_referenceGW-123x_payment_referencePAY-456x_statusCAPTUREDx_created1729857600000';
  assert.equal(tapHashString(body), expectedString);
  const hash = crypto.createHmac('sha256', secret).update(expectedString).digest('hex');
  assert.equal(verifyTapWebhook(body, hash, secret), true);
  assert.equal(verifyTapWebhook(body, hash.toUpperCase(), secret), true);
  assert.equal(verifyTapWebhook(body, hash, 'sk_wrong'), false);
  assert.equal(verifyTapWebhook({ ...body, amount: 13.11 }, hash, secret), false);
  assert.equal(verifyTapWebhook(body, '', secret), false);
  assert.equal(verifyTapWebhook(body, 'deadbeef', secret), false);
  // Missing gateway reference → empty value, 3-decimal currency
  const kwd = { id: 'chg_1', amount: 1.5, currency: 'KWD', status: 'CAPTURED', reference: { payment: 'P1' }, transaction: { created: '1' } };
  assert.equal(tapHashString(kwd), 'x_idchg_1x_amount1.500x_currencyKWDx_gateway_referencex_payment_referenceP1x_statusCAPTUREDx_created1');
});

test('createTapCharge sends the documented body and returns the hosted page', async () => {
  const calls = stubFetch(() => ({ body: { id: 'chg_abc123', status: 'INITIATED', transaction: { url: 'https://checkout.payments.tap.company/pay/abc' } } }));
  const r = await createTapCharge({
    order: { number: 'P2P-123456' }, amountMinor: 11445, currency: 'sar',
    customer: { name: 'Abdulrahman Ali', email: 'a@example.com', phone: '+966 50 123 4567' },
    redirectUrl: 'https://shop.example/orders/P2P-123456?tap=1', postUrl: 'https://shop.example/api/payments/tap/webhook',
    secretKey: 'sk_test_1', description: 'Order P2P-123456',
  });
  assert.equal(r.chargeId, 'chg_abc123');
  assert.equal(r.redirectUrl, 'https://checkout.payments.tap.company/pay/abc');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${TAP_API}/charges`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk_test_1');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.amount, 114.45);
  assert.equal(body.currency, 'SAR');
  assert.equal(body.threeDSecure, true);
  assert.equal(body.save_card, false);
  assert.equal(body.source.id, 'src_all');
  assert.equal(body.redirect.url, 'https://shop.example/orders/P2P-123456?tap=1');
  assert.equal(body.post.url, 'https://shop.example/api/payments/tap/webhook');
  assert.equal(body.metadata.order_number, 'P2P-123456');
  assert.equal(body.reference.order, 'P2P-123456');
  assert.match(body.reference.transaction, /^txn_P2P-123456_\d+$/);
  assert.deepEqual(body.customer, { first_name: 'Abdulrahman', last_name: 'Ali', email: 'a@example.com', phone: { country_code: '966', number: '501234567' } });
  assert.equal(body.description, 'Order P2P-123456');
});

test('createTapCharge surfaces Tap errors', async () => {
  stubFetch(() => ({ status: 400, body: { errors: [{ code: '103', description: 'Invalid currency' }] } }));
  await assert.rejects(
    createTapCharge({ order: { number: 'P2P-1' }, amountMinor: 100, currency: 'XXX', redirectUrl: 'https://x/y', secretKey: 'sk' }),
    /Invalid currency/,
  );
  await assert.rejects(createTapCharge({ order: { number: 'P2P-1' }, amountMinor: 0, currency: 'SAR', redirectUrl: 'https://x', secretKey: 'sk' }), /positive/);
});

test('retrieveTapCharge and createTapRefund', async () => {
  const calls = stubFetch((url) => (url.endsWith('/refunds')
    ? { body: { id: 'ref_1', status: 'PENDING' } }
    : { body: { id: 'chg_abc', status: 'CAPTURED', amount: 114.45, currency: 'SAR' } }));
  const c = await retrieveTapCharge('chg_abc', 'sk_1');
  assert.equal(c.status, 'CAPTURED');
  assert.equal(calls[0].url, `${TAP_API}/charges/chg_abc`);
  assert.equal(calls[0].init.method, 'GET');
  await assert.rejects(retrieveTapCharge('../etc', 'sk_1'), /Invalid/);
  const r = await createTapRefund({ chargeId: 'chg_abc', amountMinor: 5000, currency: 'SAR', reason: 'bogus', secretKey: 'sk_1' });
  assert.equal(r.refundId, 'ref_1');
  const body = JSON.parse(calls[1].init.body);
  assert.equal(body.charge_id, 'chg_abc');
  assert.equal(body.amount, 50);
  assert.equal(body.currency, 'SAR');
  assert.equal(body.reason, 'requested_by_customer');
});
