import { api } from '../api.js';
import { t } from '../i18n.js';
import { state } from '../state.js';
import { html, money, moneyAmount, date, statusPill, num } from '../ui.js';

export default async function orders(view, { navigate }) {
  if (!state.user) { navigate('/signin?next=/orders', { replace: true }); return; }
  const list = await api('/api/orders');
  view.innerHTML = String(html`<div class="wrap" style="max-width:900px">
    <h1 style="font-size:30px;margin:24px 0 16px">${t('orders.title')}</h1>
    ${list.length ? list.map((o) => html`<a class="order-row" href="/orders/${o.number}" data-link>
        <div class="thumbs-mini">${o.thumbs.map((src) => html`<img src="${src || ''}" alt="">`)}</div>
        <div><strong>${o.number}</strong><div class="small muted">${t('order.placed', { date: date(o.createdAt) })} · ${t('cart.items', { n: num(o.itemCount) })}</div></div>
        <div style="text-align:end;display:grid;gap:4px;justify-items:end">${statusPill(o.status)}<span class="num" style="font-weight:600">${o.display ? moneyAmount(o.display.total, o.display.currency) : money(o.totalCents, 'SAR')}</span></div>
      </a>`)
      : html`<div class="empty panel"><h2>${t('orders.empty')}</h2><p class="muted">${t('orders.emptyHint')}</p><a class="btn btn-primary" href="/" data-link>${t('common.home')}</a></div>`}
  </div>`);
}
