// App shell: boot, layout, routing, language and delivery destination.
import { api, qs, loadSessionUser } from './api.js';
import { t, tr, setLocale, getLocale } from './i18n.js';
import { state, loadSavedDestination, saveDestination } from './state.js';
import { html, raw, icons, modal, countryOptions, countryName, toast } from './ui.js';

const routes = [
  ['/', () => import('./pages/home.js')],
  ['/search', () => import('./pages/search.js')],
  ['/c/:category', () => import('./pages/search.js')],
  ['/p/:slug', () => import('./pages/product.js')],
  ['/create', () => import('./pages/create.js')],
  ['/cart', () => import('./pages/cart.js')],
  ['/checkout', () => import('./pages/checkout.js')],
  ['/orders', () => import('./pages/orders.js')],
  ['/orders/:number', () => import('./pages/order.js')],
  ['/account', () => import('./pages/account.js')],
  ['/account/:tab', () => import('./pages/account.js')],
  ['/signin', () => import('./pages/auth.js')],
  ['/signup', () => import('./pages/auth.js')],
  ['/admin', () => import('./pages/admin.js')],
  ['/admin/:section', () => import('./pages/admin.js')],
];

function match(pathname) {
  for (const [pattern, load] of routes) {
    const keys = [];
    const rx = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}/?$`);
    const m = pathname.match(rx);
    if (m) return { load, params: Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}

let cleanup = null;
let renderToken = 0;

// The app runs from a file:// bundle (and from any static host), so routes live in the hash:
// index.html#/p/chess-knight?country=SA. `currentUrl()` presents that as a normal URL.
export function currentUrl() {
  const h = location.hash.startsWith('#') ? location.hash.slice(1) : '';
  return new URL(h.startsWith('/') ? h : `/${h}`, 'http://app.local');
}
export function navigate(to, { replace = false } = {}) {
  const target = `#${to.startsWith('/') ? to : `/${to}`}`;
  if (replace) history.replaceState(history.state, '', target);
  else if (location.hash !== target) history.pushState({}, '', target);
  render();
}
export function replaceUrl(to) { history.replaceState(history.state, '', `#${to}`); }

export async function refreshBoot() {
  await loadSessionUser();
  state.boot = await api(`/api/bootstrap${qs({ country: loadSavedDestination()?.country, region: loadSavedDestination()?.region })}`);
  state.user = state.boot.user;
  state.cartCount = state.boot.cartCount;
  state.display = state.boot.display || state.display;
  const saved = loadSavedDestination();
  state.destination = saved?.country ? saved : state.boot.destination;
  return true;
}

export function setCartCount(n) {
  state.cartCount = n;
  const el = document.querySelector('.cart-count');
  if (el) { el.textContent = n; el.hidden = !n; }
}

function header() {
  const u = state.user;
  const cats = state.boot.categories;
  return html`
  <header class="site-header">
    <div class="wrap hdr">
      <a class="logo" href="/" data-link aria-label="Prompt2Print"><img src="img/logo.svg" alt="" width="34" height="34"><span>Prompt<b>2</b>Print</span></a>
      <button class="deliver" type="button" data-action="deliver"><small>${t('deliver.to')}</small><strong>${countryName(state.destination.country)}</strong></button>
      <form class="search" role="search" data-search>
        <input type="search" name="q" placeholder="${t('search.placeholder')}" aria-label="${t('search.button')}" value="${currentUrl().searchParams.get('q') || ''}">
        <button type="submit" aria-label="${t('search.button')}">${icons.search}</button>
      </form>
      <div class="hdr-actions">
        <button class="hdr-link" type="button" data-action="lang" lang="${getLocale() === 'ar' ? 'en' : 'ar'}">${icons.globe}<span class="lbl">${t('nav.lang')}</span></button>
        ${u ? html`<a class="hdr-link" href="/account" data-link>${icons.user}<span class="lbl">${u.name.split(' ')[0]}</span></a>`
          : html`<a class="hdr-link" href="/signin" data-link>${icons.user}<span class="lbl">${t('nav.signin')}</span></a>`}
        <a class="hdr-link cart-link" href="/cart" data-link aria-label="${t('nav.cart')}">${icons.cart}<span class="cart-count" ${state.cartCount ? '' : raw('hidden')}>${state.cartCount}</span><span class="lbl">${t('nav.cart')}</span></a>
      </div>
    </div>
    <nav class="subnav" aria-label="Categories"><div class="wrap">
      <a class="create-link" href="/create" data-link>${t('nav.create')}</a>
      <a href="/search" data-link>${t('nav.all')}</a>
      ${cats.map((c) => html`<a href="/c/${c.slug}" data-link>${tr(c.name)}</a>`)}
      ${u ? html`<a href="/orders" data-link>${t('nav.orders')}</a>` : ''}
      ${u?.role === 'admin' ? html`<a href="/admin" data-link>${t('nav.admin')}</a>` : ''}
    </div></nav>
  </header>`;
}

function footer() {
  return html`<footer class="site-footer"><div class="wrap">
    <div class="cols">
      <div><a class="logo" href="/" data-link><img src="img/logo.svg" alt="" width="34" height="34"><span>Prompt<b>2</b>Print</span></a><p style="margin-top:10px;max-width:36ch">${t('footer.tag')}</p></div>
      <div><h4>${t('footer.shop')}</h4><a href="/create" data-link>${t('nav.create')}</a><a href="/search" data-link>${t('nav.all')}</a>${state.boot.categories.slice(0, 3).map((c) => html`<a href="/c/${c.slug}" data-link>${tr(c.name)}</a>`)}</div>
      <div><h4>${t('footer.help')}</h4><a href="/#pricing" data-link>${t('footer.pricing')}</a><a href="/orders" data-link>${t('footer.track')}</a><a href="/create" data-link>${t('footer.privacy')}</a></div>
      <div><h4>${t('footer.company')}</h4><a href="/account" data-link>${t('nav.account')}</a><a href="/cart" data-link>${t('nav.cart')}</a></div>
    </div>
    <div class="legal">© ${new Date().getFullYear()} ${state.boot.storeName}</div>
  </div></footer>`;
}

function shell(isAdmin) {
  const app = document.getElementById('app');
  if (isAdmin) {
    app.innerHTML = '<main id="view"></main>';
  } else {
    app.innerHTML = `${header()}<main id="view" tabindex="-1"></main>${footer()}`;
  }
  app.dataset.layout = isAdmin ? 'admin' : 'store';
}

export async function render() {
  const token = ++renderToken;
  const url = currentUrl();
  const m = match(url.pathname);
  const isAdmin = url.pathname.startsWith('/admin');
  const app = document.getElementById('app');
  if (app.dataset.layout !== (isAdmin ? 'admin' : 'store') || app.dataset.locale !== getLocale() || app.dataset.user !== String(state.user?.id || '')) {
    shell(isAdmin);
    app.dataset.locale = getLocale();
    app.dataset.user = String(state.user?.id || '');
  }
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
  const view = document.getElementById('view');
  document.querySelectorAll('.subnav a').forEach((a) => {
    if (a.getAttribute('href') === url.pathname) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  if (!m) {
    view.innerHTML = String(html`<div class="wrap empty"><h1>${t('common.notFound')}</h1><p><a class="btn" href="/" data-link>${t('common.home')}</a></p></div>`);
    return;
  }
  try {
    const mod = await m.load();
    if (token !== renderToken) return;
    const result = await mod.default(view, { params: m.params, query: Object.fromEntries(url.searchParams), path: url.pathname, navigate });
    if (token !== renderToken) { if (typeof result === 'function') result(); return; }
    cleanup = typeof result === 'function' ? result : null;
    if (url.hash) document.querySelector(url.hash)?.scrollIntoView();
    else if (!history.state?.keepScroll) window.scrollTo(0, 0);
  } catch (err) {
    console.error(err);
    if (err.status === 401) { navigate(`/signin?next=${encodeURIComponent(url.pathname + url.search)}`, { replace: true }); return; }
    view.innerHTML = String(html`<div class="wrap empty"><h1>${err.status === 404 ? t('common.notFound') : t('common.error')}</h1><p class="muted">${err.message}</p><a class="btn" href="/" data-link>${t('common.home')}</a></div>`);
  }
}

function openDeliverModal() {
  const addresses = state.user ? api('/api/addresses') : Promise.resolve([]);
  addresses.then((list) => {
    const m = modal(String(html`<h2>${t('deliver.title')}</h2><p class="muted small">${t('deliver.help')}</p>
      <form data-dest class="form-grid">
        ${list.length ? html`<label class="field full">${t('deliver.address')}<select class="input" name="addressId"><option value="">—</option>${list.map((a) => html`<option value="${a.id}" ${state.destination.addressId === a.id ? raw('selected') : ''}>${a.label || a.fullName}: ${a.city}, ${countryName(a.country)}</option>`)}</select></label>` : ''}
        <label class="field">${t('addr.country')}<select class="input" name="country">${countryOptions(state.destination.country)}</select></label>
        <label class="field">${t('deliver.region')}<input class="input" name="region" value="${state.destination.region || ''}"></label>
        <div class="modal-actions full"><button type="button" class="btn" data-close>${t('common.cancel')}</button><button class="btn btn-primary">${t('deliver.save')}</button></div>
      </form>`));
    m.el.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const addressId = Number(f.get('addressId')) || null;
      const a = list.find((x) => x.id === addressId);
      saveDestination(a ? { country: a.country, region: a.region || '', addressId: a.id } : { country: f.get('country'), region: String(f.get('region') || '') });
      m.close();
      refreshBoot().then(() => { document.getElementById('app').dataset.layout = ''; render(); });
    });
  });
}

async function toggleLanguage() {
  const next = getLocale() === 'ar' ? 'en' : 'ar';
  setLocale(next);
  try { localStorage.setItem('p2p_locale', next); } catch { /* ignore */ }
  if (state.user) api('/api/me', { method: 'PATCH', body: { locale: next } }).catch(() => {});
  render();
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (a && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
    e.preventDefault();
    const href = a.getAttribute('href') || '/';
    navigate(href.startsWith('#') ? href.slice(1) : href);
    return;
  }
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'deliver') openDeliverModal();
  if (action === 'lang') toggleLanguage();
});

document.addEventListener('submit', (e) => {
  if (!e.target.matches('[data-search]')) return;
  e.preventDefault();
  const q = new FormData(e.target).get('q').trim();
  navigate(`/search${qs({ q })}`);
});

window.addEventListener('popstate', () => render());
window.addEventListener('hashchange', () => render());

export async function signedIn(user) {
  state.user = user;
  await refreshBoot();
  if (user.locale && user.locale !== getLocale()) setLocale(user.locale);
  toast(t('auth.welcome', { name: user.name.split(' ')[0] }));
}

async function boot() {
  let saved = null;
  try { saved = localStorage.getItem('p2p_locale'); } catch { /* ignore */ }
  setLocale(saved || (navigator.language?.startsWith('ar') ? 'ar' : 'en'));
  try {
    await refreshBoot();
  } catch (err) {
    document.getElementById('app').innerHTML = String(html`<div class="setup-screen"><div><h1>Prompt2Print</h1><p>${t('common.offline')}</p><p class="small" style="color:#AEB7C1">${err.message}</p>
      <button class="btn btn-primary" style="margin-top:16px" onclick="location.reload()">${t('common.retry')}</button></div></div>`);
    return;
  }
  if (!saved && state.user?.locale) setLocale(state.user.locale);
  document.getElementById('app').dataset.layout = '';
  render();
}

boot();
