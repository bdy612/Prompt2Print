import { api, qs } from '../api.js';
import { t, tr } from '../i18n.js';
import { state, destQuery } from '../state.js';
import { html, productCard, raw, num } from '../ui.js';

const SORTS = ['featured', 'bestselling', 'rating', 'price_asc', 'price_desc', 'newest'];

export default async function search(view, { params, query, navigate, path }) {
  const category = params.category || query.category || '';
  const cat = state.boot.categories.find((c) => c.slug === category);
  const sort = query.sort || 'featured';
  const page = Number(query.page) || 1;
  const data = await api(`/api/products${qs({ q: query.q, category, sort, page, limit: 24, ...destQuery() })}`);
  const title = query.q ? t('search.results', { n: num(data.total), q: query.q }) : cat ? tr(cat.name) : t('search.all');

  view.innerHTML = String(html`<div class="wrap">
    <div class="section-head" style="margin-top:24px;flex-wrap:wrap">
      <div><h1 style="font-size:28px">${title}</h1>${!query.q ? html`<p class="muted small" style="margin:4px 0 0">${num(data.total)}</p>` : ''}</div>
      <label class="field" style="flex-direction:row;display:flex;align-items:center;gap:8px">${t('sort.label')}
        <select class="input" data-sort style="width:auto">${SORTS.map((s) => html`<option value="${s}" ${s === sort ? raw('selected') : ''}>${t(`sort.${s}`)}</option>`)}</select>
      </label>
    </div>
    ${data.items.length ? html`<div class="grid">${data.items.map(productCard)}</div>`
      : html`<div class="empty panel"><h2>${t('search.none')}</h2><p class="muted">${t('search.noneHint')}</p>
          <a class="btn btn-primary" href="/create${qs({ prompt: query.q })}" data-link>${t('nav.create')}</a></div>`}
    ${data.pages > 1 ? html`<div class="row-actions" style="justify-content:center;margin-top:24px">
      ${Array.from({ length: data.pages }, (_, i) => i + 1).map((n) => html`<a class="btn btn-sm ${n === page ? 'btn-dark' : ''}" href="${path}${qs({ ...query, page: n })}" data-link>${n}</a>`)}</div>` : ''}
  </div>`);

  view.querySelector('[data-sort]').addEventListener('change', (e) => navigate(`${path}${qs({ ...query, sort: e.target.value, page: 1 })}`));
}
