import { api, qs } from '../api.js';
import { t, tr, getLocale } from '../i18n.js';
import { state, destQuery } from '../state.js';
import { html, raw, money, num, stars, productCard, toast, date, dims, countryName, icons, esc, safetyNotice } from '../ui.js';
import { mountOptions } from '../options.js';
import { createViewer, webglAvailable } from '../viewer.js';
import { setCartCount, navigate, currentUrl } from '../app.js';

export default async function product(view, { params }) {
  const p = await api(`/api/products/${encodeURIComponent(params.slug)}${qs(destQuery())}`);
  document.title = `${tr(p.name)} · Prompt2Print`;
  let inWishlist = p.inWishlist;

  view.innerHTML = String(html`<div class="wrap">
    <nav class="crumbs" aria-label="Breadcrumb"><a href="/" data-link>Prompt2Print</a><span>›</span>
      ${p.category ? html`<a href="/c/${p.category.slug}" data-link>${tr(p.category.name)}</a><span>›</span>` : ''}<span>${tr(p.name)}</span></nav>
    <div class="pdp">
      <div class="gallery">
        <div class="stage" data-stage>
          <img data-main src="${p.images[0] || ''}" alt="${tr(p.name)}" width="640" height="640">
          <span class="stage-note" data-note hidden>${t('pdp.drag')}</span>
        </div>
        <div class="thumbs" role="group">
          ${p.images.map((src, i) => html`<button type="button" data-img="${src}" aria-pressed="${i === 0}"><img src="${src}" alt="" width="72" height="72"></button>`)}
          ${webglAvailable() ? html`<button type="button" class="t3d" data-3d aria-pressed="false" title="${t('pdp.drag')}">${t('pdp.view3d')}</button>` : ''}
        </div>
        <p class="tiny muted" style="margin:0">${t('pdp.previewNote')}</p>
      </div>
      <div class="buybox">
        <div>
          <h1>${tr(p.name)}</h1>
          <div style="display:flex;gap:14px;align-items:center;margin-top:6px;flex-wrap:wrap">${stars(p.rating, p.ratingCount)}<span class="small muted">${t('pdp.sold', { n: num(p.soldCount) })}</span></div>
        </div>
        <div>
          <div class="big-price" data-big>—</div>
          <div class="small muted" style="margin-top:4px">${t('price.includes')} · <button class="btn-ghost" style="border:0;background:none;padding:0;color:var(--filament-ink);cursor:pointer;text-decoration:underline" data-action="deliver">${t('price.delivered', { country: countryName(state.destination.country) })}</button></div>
        </div>
        <div class="buybox" data-options></div>
        <div class="buy-actions">
          <button class="btn btn-primary" data-add>${t('pdp.add')}</button>
          <button class="icon-btn" data-wish aria-pressed="${inWishlist}" aria-label="${inWishlist ? t('pdp.unwish') : t('pdp.wishlist')}">${inWishlist ? icons.heartFill : icons.heart}</button>
        </div>
        <p class="error-text small" data-fragile hidden style="margin:0">${t('pdp.fragile')}</p>
        <div data-receipt></div>
        ${safetyNotice()}
        <div class="panel" style="padding:14px 16px"><div class="opt-label" style="margin-bottom:8px">${t('pdp.printability')}</div><div data-checks></div></div>
      </div>
    </div>

    <div class="panel" style="margin-top:32px">
      <div class="tabs-row" role="tablist">
        <button role="tab" aria-selected="true" data-tab="desc">${t('pdp.description')}</button>
        <button role="tab" aria-selected="false" data-tab="details">${t('pdp.details')}</button>
        <button role="tab" aria-selected="false" data-tab="reviews">${t('pdp.reviews')} (${num(p.ratingCount)})</button>
      </div>
      <div data-tabpanel="desc"><p style="max-width:70ch">${tr(p.description)}</p></div>
      <div data-tabpanel="details" hidden>
        <dl class="info-list" data-details></dl>
      </div>
      <div data-tabpanel="reviews" hidden></div>
    </div>

    ${p.related.length ? html`<section class="section"><div class="section-head"><h2>${t('pdp.related')}</h2></div><div class="grid">${p.related.map(productCard)}</div></section>` : ''}
  </div>`);

  // Gallery and 3D viewer
  const stage = view.querySelector('[data-stage]');
  const mainImg = view.querySelector('[data-main]');
  let viewer = null;
  let current = { colorHex: null, material: p.defaults.material, scale: p.defaults.scale };
  const thumbs = view.querySelectorAll('.thumbs button');
  const press = (btn) => thumbs.forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
  async function show3d() {
    press(view.querySelector('[data-3d]'));
    mainImg.hidden = true;
    view.querySelector('[data-note]').hidden = false;
    if (!viewer) {
      viewer = createViewer(stage, { theme: 'light' });
      await viewer.load(p.modelId, { color: current.colorHex, material: current.material });
      viewer.setScale(current.scale, true);
    }
  }
  thumbs.forEach((b) => b.addEventListener('click', () => {
    if (b.dataset['3d'] !== undefined) return show3d();
    press(b);
    mainImg.src = b.dataset.img;
    mainImg.hidden = false;
    view.querySelector('[data-note]').hidden = true;
    if (viewer) { viewer.dispose(); viewer = null; }
  }));

  // Options and live price
  const big = view.querySelector('[data-big]');
  const details = view.querySelector('[data-details]');
  const options = mountOptions(view.querySelector('[data-options]'), {
    allowed: p.allowedMaterials,
    defaults: p.defaults,
    minScale: p.minScale,
    maxScale: p.maxScale,
    baseSizeMm: p.analysis.sizeMm,
    quoteTarget: () => ({ productSlug: p.slug }),
    receiptEl: view.querySelector('[data-receipt]'),
    checksEl: view.querySelector('[data-checks]'),
    onChange: (o) => {
      const colorChanged = current.colorHex && o.colorHex !== current.colorHex;
      current = { colorHex: o.colorHex, material: o.material, scale: o.scale };
      if (viewer) { viewer.setColor(o.colorHex); viewer.setMaterial(o.material); viewer.setScale(o.scale); }
      else if (colorChanged && webglAvailable()) show3d();
    },
    onQuote: (q, o) => {
      big.textContent = q ? money(q.breakdown.totalCents, q.display) : '—';
      view.querySelector('[data-fragile]').hidden = !(q && q.printability.fragile);
      view.querySelector('[data-add]').disabled = !q || !q.printability.ok || !q.shipsToDestination;
      if (q) {
        details.innerHTML = String(html`
          <dt>${t('pdp.dimensions')}</dt><dd>${dims(q.line.sizeMm)}</dd>
          <dt>${t('pdp.material')}</dt><dd>${tr(q.line.materialName)} · ${tr(q.line.colorName)}</dd>
          <dt>${t('pdp.heat')}</dt><dd>~${o.material === 'ASA' ? 100 : 85} °C</dd>
          <dt>${t('pdp.infill')}</dt><dd>${o.infill}%</dd>
          <dt>${t('check.supports')}</dt><dd>${q.printability.needsSupports ? t('pdp.supports') : t('check.supportsNo')}</dd>`);
      }
    },
  });

  view.querySelector('[data-add]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const cart = await api('/api/cart/items', { method: 'POST', body: { productSlug: p.slug, ...options.get(), ...destQuery() } });
      setCartCount(cart.count);
      toast(t('pdp.added'));
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  });

  view.querySelector('[data-wish]').addEventListener('click', async (e) => {
    if (!state.user) return navigate(`/signin?next=${encodeURIComponent(currentUrl().pathname)}`);
    const btn = e.currentTarget;
    try {
      if (inWishlist) await api(`/api/wishlist/${p.id}`, { method: 'DELETE' });
      else await api('/api/wishlist', { method: 'POST', body: { productId: p.id } });
      inWishlist = !inWishlist;
      btn.innerHTML = String(inWishlist ? icons.heartFill : icons.heart);
      btn.setAttribute('aria-pressed', String(inWishlist));
      btn.setAttribute('aria-label', inWishlist ? t('pdp.unwish') : t('pdp.wishlist'));
      toast(inWishlist ? t('pdp.wishlisted') : t('pdp.unwish'));
    } catch (err) { toast(err.message, 'err'); }
  });

  // Tabs
  const tabs = view.querySelectorAll('[data-tab]');
  tabs.forEach((tab) => tab.addEventListener('click', () => {
    tabs.forEach((x) => x.setAttribute('aria-selected', String(x === tab)));
    view.querySelectorAll('[data-tabpanel]').forEach((panel) => { panel.hidden = panel.dataset.tabpanel !== tab.dataset.tab; });
    if (tab.dataset.tab === 'reviews') loadReviews();
  }));

  async function loadReviews() {
    const panel = view.querySelector('[data-tabpanel="reviews"]');
    const list = await api(`/api/products/${p.slug}/reviews`);
    const total = Object.values(p.ratingDistribution).reduce((a, b) => a + b, 0) || 1;
    panel.innerHTML = String(html`<div class="reviews">
      <div>
        <div style="font-size:34px;font-weight:640">${num(p.rating, 1)}</div>${stars(p.rating)}<p class="small muted">${t('pdp.ratings', { n: num(p.ratingCount) })}</p>
        <div class="dist">${[5, 4, 3, 2, 1].map((r) => html`<div class="bar"><span>${r} ★</span><i><b style="width:${((p.ratingDistribution[r] || 0) / total) * 100}%"></b></i><span class="num">${p.ratingDistribution[r] || 0}</span></div>`)}</div>
        ${state.user ? html`<form data-review class="opt" style="margin-top:20px">
            <h3 style="font-size:16px">${t('pdp.writeReview')}</h3>
            <select class="input" name="rating" aria-label="Rating">${[5, 4, 3, 2, 1].map((r) => html`<option value="${r}">${'★'.repeat(r)}${'☆'.repeat(5 - r)}</option>`)}</select>
            <input class="input" name="title" placeholder="${t('pdp.reviewTitle')}" maxlength="120">
            <textarea class="input" name="body" placeholder="${t('pdp.reviewBody')}" required minlength="5"></textarea>
            <button class="btn btn-dark">${t('pdp.submitReview')}</button>
          </form>` : html`<p class="small" style="margin-top:20px"><a href="/signin?next=${encodeURIComponent(currentUrl().pathname)}" data-link>${t('pdp.signinReview')}</a></p>`}
      </div>
      <div>${list.length ? list.map((r) => html`<article class="review" lang="${r.locale}" dir="${r.locale === 'ar' ? 'rtl' : 'ltr'}">
          ${stars(r.rating)}<h4>${r.title || ''}</h4><p style="margin:0 0 6px">${r.body}</p>
          <div class="meta">${r.author_name} · ${date(r.created_at)}${r.verified ? html` · <span class="badge">${t('pdp.verified')}</span>` : ''}</div></article>`)
        : html`<p class="muted">${t('pdp.noReviews')}</p>`}</div>
    </div>`);
    panel.querySelector('[data-review]')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      try {
        await api(`/api/products/${p.slug}/reviews`, { method: 'POST', body: f });
        toast(t('pdp.reviewThanks'));
        loadReviews();
      } catch (err) { toast(err.message, 'err'); }
    });
  }

  return () => viewer?.dispose();
}

export { esc, raw, getLocale };
