import { api } from '../api.js';
import { t, tr } from '../i18n.js';
import { state } from '../state.js';
import { html, raw, money, moneyAmount, num, date, dateTime, dims, statusPill, toast, addressText, countryName, safetyNotice } from '../ui.js';

const FLOW = ['paid', 'in_queue', 'printing', 'printed', 'packed', 'shipped', 'delivered'];

function payPanel(o) {
  if (state.boot.payments.provider === 'unconfigured') {
    return html`<section class="panel pay-card"><h2 style="font-size:19px;margin-bottom:8px">${t('pay.title')}</h2><p class="error-text">${t('pay.unconfigured')}</p></section>`;
  }
  if (state.boot.payments.provider === 'tap' || state.boot.payments.provider === 'stripe') {
    const disp = o.display ? moneyAmount(o.display.total, o.display.currency) : money(o.totalCents, 'SAR');
    return html`<section class="panel pay-card"><h2 style="font-size:19px;margin-bottom:8px">${t('pay.title')}</h2>
      <p class="small muted">${t('pay.pay', { total: disp })}</p>
      <button class="btn btn-primary btn-block" data-gateway="${state.boot.payments.provider}" style="min-height:50px">${t('pay.card')}</button>
      ${safetyNotice(true)}</section>`;
  }
  return html`<section class="panel pay-card">
    <h2 style="font-size:19px;margin-bottom:4px">${t('pay.title')}</h2>
    <p class="small muted">${t('pay.testMode')}</p>
    <div class="card-preview"><span class="small">Prompt2Print · TEST</span><span class="no" data-cardno>4242 4242 4242 4242</span><span class="small" data-cardname>${state.user.name}</span></div>
    <form data-pay class="form-grid">
      <label class="field full">${t('pay.cardNumber')}<input class="input" name="number" inputmode="numeric" autocomplete="cc-number" dir="ltr" value="4242 4242 4242 4242" required></label>
      <label class="field">${t('pay.expiry')}<input class="input" name="expiry" placeholder="MM/YY" dir="ltr" value="12/${String(new Date().getFullYear() + 2).slice(2)}" required></label>
      <label class="field">${t('pay.cvc')}<input class="input" name="cvc" inputmode="numeric" dir="ltr" value="123" required></label>
      <label class="field full">${t('pay.name')}<input class="input" name="name" value="${state.user.name}"></label>
      <button class="btn btn-primary full" style="min-height:50px">${t('pay.pay', { total: money(o.totalCents, o.currency) })}</button>
      <p class="tiny muted full" style="margin:0">${t('pay.testCards')}</p>
    </form></section>`;
}

export default async function order(view, { params, query, navigate }) {
  if (!state.user) { navigate(`/signin?next=/orders/${params.number}`, { replace: true }); return; }
  let o;
  if (query.session_id || query.tap_return || query.tap_id) {
    o = await api(`/api/orders/${params.number}/confirm`, { method: 'POST', body: { sessionId: query.session_id, tapId: query.tap_id } }).catch(() => null);
    replaceUrl(`/orders/${params.number}`);
    if (o && o.status === 'pending_payment') toast(t('pay.failed'), 'err');
    else if (o) toast(t('pay.success'));
  }
  o = o || await api(`/api/orders/${params.number}`);
  if (query.cancelled) toast(t('pay.cancelled'), 'err');
  let timer = null;
  let awaitingPayment = false;
  let pendingCharge = null;

  function render() {
    const od = o.display ? { currency: o.display.currency, rate: o.display.rate, decimals: o.pricing.display?.decimals ?? 2 } : { currency: o.currency, rate: 1, decimals: 2 };
    const reachedIdx = FLOW.indexOf(o.status);
    const when = (s) => o.events.filter((e) => e.status === s).at(-1)?.created_at;
    const terminal = ['cancelled', 'refunded'].includes(o.status);
    view.innerHTML = String(html`<div class="wrap">
      <div style="display:flex;justify-content:space-between;align-items:end;gap:12px;flex-wrap:wrap;margin:24px 0 16px">
        <div><h1 style="font-size:28px">${t('order.title', { number: o.number })}</h1><p class="muted small" style="margin:4px 0 0">${t('order.placed', { date: dateTime(o.createdAt) })}</p></div>
        <div style="display:flex;gap:10px;align-items:center">${statusPill(o.status)}${['in_queue', 'printing', 'paid'].includes(o.status) ? html`<span class="tiny muted">${t('order.live')}</span>` : ''}</div>
      </div>
      <div class="two-col">
        <div style="display:grid;gap:16px">
          ${o.status === 'pending_payment' ? payPanel(o) : ''}
          <section class="panel">
            <h2 style="font-size:19px;margin-bottom:14px">${t('order.track')}</h2>
            ${terminal ? html`<p>${statusPill(o.status)} ${o.refundedCents ? t('order.refunded', { amount: money(o.refundedCents, o.currency) }) : ''}</p>` : html`
            <ol class="timeline">${FLOW.map((s, i) => {
              const done = reachedIdx >= i && o.status !== 'pending_payment';
              const now = reachedIdx === i;
              return html`<li class="${done ? 'done' : ''} ${now && s !== 'delivered' ? 'now' : ''}"><span class="mark">${i + 1}</span>
                <div><strong>${t(`status.${s}`)}</strong>${when(s) ? html`<div class="when">${dateTime(when(s))}</div>` : ''}
                ${s === 'printing' && (o.status === 'printing' || o.status === 'in_queue') ? html`<div style="display:grid;gap:8px;margin-top:8px">${o.items.flatMap((it) => it.jobs.map((j) => html`
                  <div class="small"><div style="display:flex;justify-content:space-between;gap:8px"><span>${tr(it.title)}${it.quantity > 1 ? ` · ${t('order.copy', { n: j.copy })}` : ''}</span><span class="muted">${t(`job.${j.status}`)}${j.status === 'printing' ? ` · ${j.progress}%` : ''}</span></div>
                  <div class="progress"><i style="width:${j.status === 'printed' ? 100 : j.progress}%"></i></div></div>`))}</div>` : ''}
                ${s === 'shipped' && o.trackingNumber ? html`<div class="small">${t('order.tracking')}: <strong dir="ltr">${o.carrier || ''} ${o.trackingNumber}</strong></div>` : ''}
                </div></li>`;
            })}</ol>`}
          </section>
          <section class="panel"><h2 style="font-size:19px">${t('order.items')}</h2>
            ${o.items.map((it) => html`<div class="line-item">
              <img src="${it.thumb || ''}" alt="">
              <div><h3>${it.productSlug ? html`<a href="/p/${it.productSlug}" data-link style="text-decoration:none">${tr(it.title)}</a>` : tr(it.title)}</h3>
                <div class="opts"><span>${it.material}</span><span><i class="dot" style="background:${it.colorHex}"></i>${it.color}</span><span>${dims(it.sizeMm)}</span><span>${t('pdp.infill')} ${it.infill}%</span><span>× ${it.quantity}</span></div></div>
              <div class="end num">${money(it.filamentCents, od)}</div></div>`)}
          </section>
        </div>
        <aside class="sticky">
          <div class="receipt">
            <div class="row total"><span class="k">${t('price.total')}</span><span class="v">${money(o.totalCents, od)}</span></div>
            <div class="note">${t('price.includes')} · ${t('price.delivered', { country: countryName(o.address?.country) })}</div>
          </div>
          <div class="panel"><h3 style="font-size:15px;margin-bottom:6px">${t('order.shipTo')}</h3><p class="small" style="margin:0">${o.address.fullName}<br>${addressText(o.address)}</p></div>
        </aside>
      </div></div>`);

    view.querySelector('[data-pay]')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button');
      btn.disabled = true;
      const f = Object.fromEntries(new FormData(e.target));
      try {
        o = await api(`/api/orders/${o.number}/pay/test`, { method: 'POST', body: { card: f } });
        toast(t('pay.success'));
        render();
        poll();
      } catch (err) {
        toast(err.message, 'err');
        btn.disabled = false;
      }
    });
    const num$ = view.querySelector('[data-pay] [name="number"]');
    num$?.addEventListener('input', () => { view.querySelector('[data-cardno]').textContent = num$.value || '•••• •••• •••• ••••'; });
    view.querySelector('[data-gateway]')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = t('pay.redirecting');
      try {
        const r = await api(`/api/orders/${o.number}/pay/${btn.dataset.gateway}`, { method: 'POST' });
        // The card page opens in the browser; this page waits for the payment to be confirmed.
        const w = window.open(r.redirectUrl, '_blank', 'noopener');
        if (!w) location.href = r.redirectUrl;
        pendingCharge = r.tapId || r.chargeId || r.id || null;
        btn.textContent = t('pay.waiting');
        awaitingPayment = true;
        poll();
      } catch (err) { toast(err.message, 'err'); btn.disabled = false; btn.textContent = t('pay.card'); }
    });
  }

  function poll() {
    clearInterval(timer);
    const live = () => ['paid', 'in_queue', 'printing'].includes(o.status) || (awaitingPayment && o.status === 'pending_payment');
    if (!live()) return;
    timer = setInterval(async () => {
      try {
        let next;
        if (awaitingPayment && o.status === 'pending_payment' && pendingCharge) {
          next = await api(`/api/orders/${o.number}/confirm`, { method: 'POST', body: { tapId: pendingCharge } }).catch(() => null);
        }
        next = next || await api(`/api/orders/${o.number}`);
        const changed = JSON.stringify(next) !== JSON.stringify(o);
        if (changed && o.status === 'pending_payment' && next.status !== 'pending_payment') { awaitingPayment = false; toast(t('pay.success')); }
        o = next;
        if (changed) render();
        if (!live()) clearInterval(timer);
      } catch { /* retry next tick */ }
    }, 4000);
  }

  render();
  poll();
  return () => clearInterval(timer);
}

export { raw, countryName, date };
