// Small UI helpers: safe HTML templates, money/number formatting, shared components.
import { t, tr, getLocale } from './i18n.js';
import { state } from './state.js';

// html`...` escapes every interpolated value unless it is wrapped with raw() or is another html result.
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(String(s));
export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmt(v) {
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(fmt).join('');
  if (v === false || v === null || v === undefined) return '';
  return esc(v);
}
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += fmt(values[i]) + strings[i + 1];
  return new Raw(out);
}

const loc = () => (getLocale() === 'ar' ? 'ar-SA-u-nu-latn' : 'en-US');
// Prices are stored in SAR (halalas) and shown in the currency of the delivery country.
// `display` = { currency, rate, decimals } from the server; defaults to the current destination's.
export function money(cents, display = state.display) {
  const d = display && typeof display === 'object' ? display : { currency: typeof display === 'string' ? display : 'SAR', rate: 1, decimals: 2 };
  const amount = ((cents || 0) / 100) * (d.rate || 1);
  const decimals = d.decimals ?? 2;
  const rounded = Math.round(amount * 10 ** decimals) / 10 ** decimals;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: d.currency, currencyDisplay: 'narrowSymbol', minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(rounded);
  } catch {
    return `${rounded.toFixed(decimals)} ${d.currency}`;
  }
}
// An amount already in the display currency (e.g. what the card was charged).
export function moneyAmount(amount, currency, decimals = 2) {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency, currencyDisplay: 'narrowSymbol', minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(amount); } catch { return `${amount} ${currency}`; }
}
export function num(v, digits = 0) {
  return new Intl.NumberFormat(loc(), { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(v || 0);
}
export function date(s, opts = { dateStyle: 'medium' }) {
  if (!s) return '';
  const d = new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);
  return new Intl.DateTimeFormat(loc(), opts).format(d);
}
export const dateTime = (s) => date(s, { dateStyle: 'medium', timeStyle: 'short' });
export const dims = (size) => (size ? `${size.map((v) => num(v, 0)).join(' × ')} ${t('common.mm')}` : '');
export const countryName = (code) => tr(state.boot?.countries.find((c) => c.code === code)) || code;

export function toast(message, type = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${type === 'err' ? 'err' : ''}`;
  el.textContent = message;
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), type === 'err' ? 6000 : 3500);
}

export function stars(rating, count) {
  const pct = Math.max(0, Math.min(100, (rating / 5) * 100));
  return html`<span class="stars" title="${num(rating, 1)} / 5"><span class="s" style="--p:${pct}%"></span>${count !== undefined ? html`<span>${num(rating, 1)} (${num(count)})</span>` : ''}</span>`;
}

export function statusPill(status, prefix = 'status') {
  return html`<span class="status s-${status}">${t(`${prefix}.${status}`)}</span>`;
}

export const icons = {
  search: raw('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>'),
  cart: raw('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 4h2l2.2 10.4a2 2 0 0 0 2 1.6h7.6a2 2 0 0 0 2-1.5L21 8H6.2"/><circle cx="10" cy="20" r="1.4"/><circle cx="17" cy="20" r="1.4"/></svg>'),
  user: raw('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>'),
  heart: raw('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 20s-7-4.4-9-9.2C1.7 7.4 4 4 7.4 4c2 0 3.4 1.1 4.6 2.6C13.2 5.1 14.6 4 16.6 4 20 4 22.3 7.4 21 10.8 19 15.6 12 20 12 20z"/></svg>'),
  heartFill: raw('<svg viewBox="0 0 24 24" fill="#D6246E" stroke="#D6246E" stroke-width="1.8" aria-hidden="true"><path d="M12 20s-7-4.4-9-9.2C1.7 7.4 4 4 7.4 4c2 0 3.4 1.1 4.6 2.6C13.2 5.1 14.6 4 16.6 4 20 4 22.3 7.4 21 10.8 19 15.6 12 20 12 20z"/></svg>'),
  globe: raw('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/></svg>'),
  rotate: raw('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 12a8 8 0 0 1 14-5.3M20 4v4h-4M20 12a8 8 0 0 1-14 5.3M4 20v-4h4"/></svg>'),
};

export function safetyNotice(compact = false) {
  return html`<div class="safety ${compact ? 'compact' : ''}" role="note"><strong>${t('safety.title')}</strong> ${t('safety.text')}</div>`;
}

export function productCard(p) {
  const price = p.price;
  return html`<a class="card" href="/p/${p.slug}" data-link>
    ${p.featured ? html`<span class="badge badge-accent">${t('home.featured').split(' ')[0]}</span>` : ''}
    <div class="img">${p.images?.[0] ? html`<img src="${p.images[0]}" alt="" loading="lazy" width="640" height="640">` : ''}</div>
    <div class="body">
      <div class="name">${tr(p.name)}</div>
      ${stars(p.rating, p.ratingCount)}
      <div class="price num">${price ? money(price.totalCents, price.display) : '—'}
        <small>${price && !price.shipsToDestination ? t('price.noShip', { country: countryName(state.destination.country) }) : t('price.delivered', { country: countryName(state.destination.country) })}</small>
      </div>
    </div>
  </a>`;
}

// What the customer sees: one final price in their currency, nothing about how it is made up.
export function receipt(q, { compact = false } = {}) {
  if (!q) return '';
  const b = q.breakdown;
  const d = q.display || state.display;
  return html`<div class="receipt">
    <div class="row total"><span class="k">${t('price.total')}</span><span class="v">${money(b.totalCents, d)}</span></div>
    <div class="note">${t('price.includes')} · ${t('price.delivered', { country: countryName(q.destination?.country || state.destination.country) })}</div>
    ${!compact && q.shipping ? html`<div class="note">${t('price.days', { min: q.shipping.days[0], max: q.shipping.days[1] })}</div>` : ''}
    ${q.shipsToDestination === false ? html`<div class="error-text">${t('price.noShip', { country: countryName(q.destination?.country) })}</div>` : ''}
  </div>`;
}

// One line only: a green "Printable" badge, or the single blocking reason in red. A small amber
// note when the shape is fragile at this size.
export function checksList(printability) {
  if (!printability) return '';
  const blocking = printability.checks.find((c) => c.status === 'fail');
  return html`<div class="printable-line">
    ${printability.ok ? html`<span class="status s-printable">${t('check.printable')}</span>`
      : html`<span class="error-text">${blocking?.detail || t('check.notPrintable')}</span>`}
    ${printability.fragile ? html`<div class="warn-text small">${t('pdp.fragile')}</div>` : ''}
  </div>`;
}

export function modal(content, { onClose } = {}) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${content}</div>`;
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); onClose?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  back.addEventListener('click', (e) => { if (e.target === back || e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(back);
  (back.querySelector('input, select, textarea') || back.querySelector('[data-close]'))?.focus();
  return { el: back.querySelector('.modal'), close };
}

export function debounce(fn, ms = 250) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

export function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

export function countryOptions(selected) {
  return state.boot.countries.map((c) => html`<option value="${c.code}" ${c.code === selected ? raw('selected') : ''}>${tr(c)}</option>`);
}

export function addressForm(a = {}) {
  return html`<div class="form-grid">
    <label class="field full">${t('addr.fullName')}<input class="input" name="fullName" required value="${a.fullName || ''}" autocomplete="name"></label>
    <label class="field">${t('addr.phone')}<input class="input" name="phone" value="${a.phone || ''}" autocomplete="tel" dir="ltr"></label>
    <label class="field">${t('addr.label')}<input class="input" name="label" value="${a.label || ''}"></label>
    <label class="field full">${t('addr.line1')}<input class="input" name="line1" required value="${a.line1 || ''}" autocomplete="address-line1"></label>
    <label class="field full">${t('addr.line2')}<input class="input" name="line2" value="${a.line2 || ''}" autocomplete="address-line2"></label>
    <label class="field">${t('addr.city')}<input class="input" name="city" required value="${a.city || ''}" autocomplete="address-level2"></label>
    <label class="field">${t('addr.region')}<input class="input" name="region" value="${a.region || ''}" autocomplete="address-level1"></label>
    <label class="field">${t('addr.postal')}<input class="input" name="postalCode" value="${a.postalCode || ''}" autocomplete="postal-code" dir="ltr"></label>
    <label class="field">${t('addr.country')}<select class="input" name="country" required>${countryOptions(a.country || state.destination.country)}</select></label>
  </div>`;
}

export function addressText(a) {
  return [a.line1, a.line2, a.city, a.region, a.postalCode, countryName(a.country)].filter(Boolean).join(getLocale() === 'ar' ? '، ' : ', ');
}

export function loading() {
  return html`<div class="loading-block"><span class="spinner" aria-label="${t('common.loading')}"></span></div>`;
}

export function errorBlock(err) {
  return html`<div class="empty"><h2>${err?.status === 404 ? t('common.notFound') : t('common.error')}</h2><p class="muted">${err?.message || ''}</p><a class="btn" href="/" data-link>${t('common.home')}</a></div>`;
}
