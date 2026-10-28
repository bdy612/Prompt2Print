import { api, qs } from '../api.js';
import { t, tr } from '../i18n.js';
import { state, destQuery } from '../state.js';
import { html, raw, money, num, receipt, dims, toast, countryName } from '../ui.js';
import { setCartCount } from '../app.js';

export function lineItem(it, { editable = true, display = state.display } = {}) {
  const href = it.slug ? `/p/${it.slug}` : it.designId ? `/create?d=${it.designId}` : null;
  return html`<div class="line-item" data-item="${it.id}">
    ${href ? html`<a href="${href}" data-link><img src="${it.thumb || ''}" alt="" width="96" height="96"></a>` : html`<img src="${it.thumb || ''}" alt="">`}
    <div>
      <h3>${href ? html`<a href="${href}" data-link style="text-decoration:none">${tr(it.title)}</a>` : tr(it.title)}</h3>
      <div class="opts">
        ${it.kind === 'design' ? html`<span class="badge badge-accent">${t('cart.aiDesign')}</span>` : ''}
        <span>${tr(it.materialName) || it.material}</span>
        <span><i class="dot" style="background:${it.colorHex}"></i>${tr(it.colorName) || it.color}</span>
        <span>${dims(it.sizeMm)}</span>
        <span>${t('pdp.infill')} ${it.infill}%</span>
      </div>
      ${it.printable === false ? html`<p class="error-text" style="margin:0">${t('cart.problem')}</p>` : ''}
      ${editable ? html`<div class="row-actions">
        <div class="qty"><button type="button" data-q="-1" aria-label="−">−</button><input data-qty value="${it.quantity}" inputmode="numeric" aria-label="${t('pdp.quantity')}"><button type="button" data-q="1" aria-label="+">+</button></div>
        <button class="btn btn-ghost btn-sm" data-remove>${t('cart.remove')}</button></div>` : html`<span class="small muted">× ${it.quantity}</span>`}
    </div>
    <div class="end num" style="font-weight:600">${money(it.filamentCents, display)}</div>
  </div>`;
}

export default async function cart(view, { navigate }) {
  async function load(data) {
    const c = data || await api(`/api/cart${qs(destQuery())}`);
    setCartCount(c.count);
    if (!c.items.length && !c.problems.length) {
      view.innerHTML = String(html`<div class="wrap"><div class="empty panel" style="margin-top:32px"><h2>${t('cart.empty')}</h2><p class="muted">${t('cart.emptyHint')}</p>
        <div class="row-actions" style="justify-content:center"><a class="btn" href="/search" data-link>${t('nav.all')}</a><a class="btn btn-primary" href="/create" data-link>${t('nav.create')}</a></div></div></div>`);
      return;
    }
    view.innerHTML = String(html`<div class="wrap">
      <h1 style="font-size:30px;margin:24px 0 16px">${t('cart.title')}</h1>
      <div class="two-col">
        <div class="panel">${c.items.map((it) => lineItem(it, { display: c.quote?.display }))}
          ${c.problems.map((p) => html`<div class="line-item"><div></div><p class="error-text">${p.message}</p><button class="btn btn-sm" data-remove-id="${p.cartItemId}">${t('cart.remove')}</button></div>`)}
        </div>
        <aside class="sticky">
          <div class="panel" style="padding:14px 16px;display:flex;justify-content:space-between;align-items:center;gap:8px">
            <span class="small">${t('deliver.to')} <strong>${countryName(c.destination.country)}</strong></span>
            <button class="btn btn-sm" data-action="deliver">${t('account.edit')}</button>
          </div>
          ${c.quote ? receipt(c.quote) : ''}
          ${state.user ? html`<button class="btn btn-primary btn-block" data-checkout style="min-height:50px" ${c.quote?.printable && c.quote?.shipsToDestination && !c.problems.length ? '' : raw('disabled')}>${t('cart.checkout')}</button>`
            : html`<a class="btn btn-primary btn-block" style="min-height:50px" href="/signin?next=/checkout" data-link>${t('cart.signinCheckout')}</a>`}
          <p class="tiny muted" style="margin:0">${t('checkout.paidNote')}</p>
        </aside>
      </div></div>`);
    view.querySelectorAll('[data-item]').forEach((row) => {
      const id = row.dataset.item;
      const qty = row.querySelector('[data-qty]');
      const update = async (q) => {
        try { load(await api(`/api/cart/items/${id}`, { method: 'PATCH', body: { quantity: q, ...destQuery() } })); } catch (err) { toast(err.message, 'err'); }
      };
      row.querySelectorAll('[data-q]').forEach((b) => b.addEventListener('click', () => update(Math.max(1, Number(qty.value) + Number(b.dataset.q)))));
      qty.addEventListener('change', () => update(Number(qty.value)));
      row.querySelector('[data-remove]').addEventListener('click', async () => load(await api(`/api/cart/items/${id}${qs(destQuery())}`, { method: 'DELETE' })));
    });
    view.querySelectorAll('[data-remove-id]').forEach((b) => b.addEventListener('click', async () => load(await api(`/api/cart/items/${b.dataset.removeId}`, { method: 'DELETE' }))));
    view.querySelector('[data-checkout]')?.addEventListener('click', () => navigate('/checkout'));
  }
  await load();
}
