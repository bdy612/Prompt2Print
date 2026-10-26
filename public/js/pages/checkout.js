import { api, qs } from '../api.js';
import { t } from '../i18n.js';
import { state, saveDestination } from '../state.js';
import { html, raw, money, receipt, toast, addressForm, addressText, formData, safetyNotice } from '../ui.js';
import { lineItem } from './cart.js';
import { setCartCount } from '../app.js';

export default async function checkout(view, { navigate }) {
  if (!state.user) { navigate('/signin?next=/checkout', { replace: true }); return; }
  let addresses = await api('/api/addresses');
  let selected = addresses.find((a) => a.id === state.destination.addressId) || addresses.find((a) => a.isDefault) || addresses[0] || null;

  async function render() {
    const c = await api(`/api/cart${qs({ addressId: selected?.id, country: selected ? undefined : state.destination.country })}`);
    if (!c.items.length) { navigate('/cart', { replace: true }); return; }
    const ok = selected && c.quote?.printable && c.quote?.shipsToDestination && !c.problems.length;
    view.innerHTML = String(html`<div class="wrap">
      <h1 style="font-size:30px;margin:24px 0 16px">${t('checkout.title')}</h1>
      <div class="two-col">
        <div style="display:grid;gap:16px">
          <section class="panel">
            <h2 style="font-size:19px;margin-bottom:12px">${t('checkout.address')}</h2>
            <div class="addr-list">${addresses.map((a) => html`<label class="addr"><input type="radio" name="addr" value="${a.id}" ${selected?.id === a.id ? raw('checked') : ''}>
              <div><strong>${a.fullName}</strong>${a.label ? html` · <span class="small muted">${a.label}</span>` : ''}<p>${addressText(a)}</p>${a.phone ? html`<p dir="ltr" style="text-align:start">${a.phone}</p>` : ''}</div></label>`)}</div>
            <details style="margin-top:12px" ${addresses.length ? '' : raw('open')}>
              <summary class="btn btn-sm" style="list-style:none">${t('checkout.addAddress')}</summary>
              <form data-addr style="margin-top:14px">${addressForm()}<button class="btn btn-dark" style="margin-top:14px">${t('addr.save')}</button></form>
            </details>
          </section>
          <section class="panel"><h2 style="font-size:19px">${t('order.items')}</h2>${c.items.map((it) => lineItem(it, { editable: false }))}</section>
        </div>
        <aside class="sticky">
          ${c.quote ? receipt(c.quote) : ''}
          <button class="btn btn-primary btn-block" data-place style="min-height:52px" ${ok ? '' : raw('disabled')}>${t('checkout.place', { total: money(c.quote?.breakdown.totalCents || 0, c.quote?.display) })}</button>
          <p class="tiny muted" style="margin:0">${t('checkout.paidNote')}</p>
          ${safetyNotice()}
        </aside>
      </div></div>`);

    view.querySelectorAll('input[name="addr"]').forEach((r) => r.addEventListener('change', () => {
      selected = addresses.find((a) => a.id === Number(r.value));
      saveDestination({ country: selected.country, region: selected.region || '', addressId: selected.id });
      render();
    }));
    view.querySelector('[data-addr]').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const a = await api('/api/addresses', { method: 'POST', body: formData(e.target) });
        addresses = await api('/api/addresses');
        selected = addresses.find((x) => x.id === a.id);
        saveDestination({ country: selected.country, region: selected.region || '', addressId: selected.id });
        render();
      } catch (err) { toast(err.message, 'err'); }
    });
    view.querySelector('[data-place]').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const order = await api('/api/checkout', { method: 'POST', body: { addressId: selected.id } });
        setCartCount(0);
        navigate(`/orders/${order.number}?pay=1`);
      } catch (err) {
        toast(err.message, 'err');
        btn.disabled = false;
      }
    });
  }
  await render();
}
