import { api } from '../api.js';
import { t, tr, getLocale, setLocale } from '../i18n.js';
import { state } from '../state.js';
import { html, raw, toast, productCard, addressForm, addressText, formData, modal, date } from '../ui.js';
import { navigate, refreshBoot, render as rerender, currentUrl } from '../app.js';

const TABS = ['profile', 'addresses', 'wishlist', 'designs'];

export default async function account(view, { params }) {
  if (!state.user) { navigate(`/signin?next=${encodeURIComponent(currentUrl().pathname)}`, { replace: true }); return; }
  const tab = TABS.includes(params.tab) ? params.tab : 'profile';
  view.innerHTML = String(html`<div class="wrap account">
    <nav class="side-nav" aria-label="${t('account.title')}">
      ${TABS.map((x) => html`<a href="/account${x === 'profile' ? '' : `/${x}`}" data-link ${x === tab ? raw('aria-current="page"') : ''}>${t(`account.${x}`)}</a>`)}
      <a href="/orders" data-link>${t('account.orders')}</a>
      ${state.user.role === 'admin' ? html`<a href="/admin" data-link>${t('nav.admin')}</a>` : ''}
      <a href="#" data-signout>${t('nav.signout')}</a>
    </nav>
    <div data-body></div>
  </div>`);
  view.querySelector('[data-signout]').addEventListener('click', async (e) => {
    e.preventDefault();
    await api('/api/auth/logout', { method: 'POST' });
    state.user = null;
    await refreshBoot();
    navigate('/');
  });
  const body = view.querySelector('[data-body]');
  await ({ profile, addresses, wishlist, designs })[tab](body);
}

async function profile(body) {
  const u = state.user;
  body.innerHTML = String(html`<h1 style="font-size:26px;margin-bottom:16px">${t('account.profile')}</h1>
    <form class="panel form-grid" data-profile>
      <label class="field">${t('account.name')}<input class="input" name="name" value="${u.name}" required></label>
      <label class="field">${t('account.email')}<input class="input" value="${u.email}" disabled dir="ltr"></label>
      <label class="field">${t('account.language')}<select class="input" name="locale"><option value="en" ${getLocale() === 'en' ? raw('selected') : ''}>English</option><option value="ar" ${getLocale() === 'ar' ? raw('selected') : ''}>العربية</option></select></label>
      <div class="full"><button class="btn btn-dark">${t('account.save')}</button></div>
    </form>
    <form class="panel form-grid" data-password style="margin-top:16px">
      <h2 class="full" style="font-size:18px">${t('account.password')}</h2>
      <label class="field">${t('account.current')}<input class="input" type="password" name="currentPassword" required autocomplete="current-password"></label>
      <label class="field">${t('account.new')}<input class="input" type="password" name="newPassword" required minlength="8" autocomplete="new-password"></label>
      <div class="full"><button class="btn">${t('account.save')}</button></div>
    </form>`);
  body.querySelector('[data-profile]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = formData(e.target);
    try {
      await api('/api/me', { method: 'PATCH', body: f });
      state.user.name = f.name;
      try { localStorage.setItem('p2p_locale', f.locale); } catch { /* ignore */ }
      setLocale(f.locale);
      toast(t('account.saved'));
      document.getElementById('app').dataset.layout = '';
      rerender();
    } catch (err) { toast(err.message, 'err'); }
  });
  body.querySelector('[data-password]').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('/api/me', { method: 'PATCH', body: formData(e.target) }); e.target.reset(); toast(t('account.saved')); } catch (err) { toast(err.message, 'err'); }
  });
}

async function addresses(body) {
  const list = await api('/api/addresses');
  body.innerHTML = String(html`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px"><h1 style="font-size:26px">${t('account.addresses')}</h1>
      <button class="btn btn-dark" data-new>${t('checkout.addAddress')}</button></div>
    ${list.length ? html`<div class="addr-list">${list.map((a) => html`<div class="addr" style="cursor:default">
        <div style="flex:1"><strong>${a.fullName}</strong>${a.isDefault ? html` <span class="badge badge-accent">${t('account.default')}</span>` : ''}${a.label ? html` · <span class="small muted">${a.label}</span>` : ''}
          <p>${addressText(a)}</p></div>
        <div class="row-actions">${!a.isDefault ? html`<button class="btn btn-sm" data-default="${a.id}">${t('account.makeDefault')}</button>` : ''}
          <button class="btn btn-sm" data-edit="${a.id}">${t('account.edit')}</button><button class="btn btn-sm btn-danger" data-del="${a.id}">${t('account.delete')}</button></div></div>`)}</div>`
      : html`<p class="muted">${t('account.noAddresses')}</p>`}`);
  const open = (a) => {
    const m = modal(String(html`<h2>${a ? t('account.edit') : t('checkout.addAddress')}</h2><form data-f>${addressForm(a || {})}
      <div class="modal-actions"><button type="button" class="btn" data-close>${t('common.cancel')}</button><button class="btn btn-primary">${t('addr.save')}</button></div></form>`));
    m.el.querySelector('[data-f]').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        if (a) await api(`/api/addresses/${a.id}`, { method: 'PATCH', body: formData(e.target) });
        else await api('/api/addresses', { method: 'POST', body: formData(e.target) });
        m.close();
        addresses(body);
      } catch (err) { toast(err.message, 'err'); }
    });
  };
  body.querySelector('[data-new]').addEventListener('click', () => open(null));
  body.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => open(list.find((a) => a.id === Number(b.dataset.edit)))));
  body.querySelectorAll('[data-default]').forEach((b) => b.addEventListener('click', async () => { await api(`/api/addresses/${b.dataset.default}`, { method: 'PATCH', body: { makeDefault: true } }); addresses(body); }));
  body.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => { await api(`/api/addresses/${b.dataset.del}`, { method: 'DELETE' }); addresses(body); }));
}

async function wishlist(body) {
  const list = await api('/api/wishlist');
  body.innerHTML = String(html`<h1 style="font-size:26px;margin-bottom:16px">${t('account.wishlist')}</h1>
    ${list.length ? html`<div class="grid">${list.map(productCard)}</div>` : html`<p class="muted">${t('account.noWishlist')}</p>`}`);
}

async function designs(body) {
  const list = await api('/api/designs');
  body.innerHTML = String(html`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px"><h1 style="font-size:26px">${t('account.designs')}</h1><a class="btn btn-primary" href="/create" data-link>${t('nav.create')}</a></div>
    ${list.length ? html`<div class="grid">${list.map((d) => html`<a class="card" href="/create?d=${d.id}" data-link>
        <div class="img">${d.thumb ? html`<img src="${d.thumb}" alt="">` : ''}</div>
        <div class="body"><div class="name">${tr(d.title) || d.prompt}</div><span class="small muted">${date(d.createdAt)}</span></div></a>`)}</div>`
      : html`<p class="muted">${t('account.noDesigns')}</p>`}`);
}
