// Options panel shared by product pages and AI Create: material, colour, size, infill, quantity.
// Every change re-prices live through /api/quote (same numbers the cart and checkout use).
import { api } from './api.js';
import { t, tr } from './i18n.js';
import { state, destQuery } from './state.js';
import { html, raw, num, money, receipt, checksList, dims, countryName, debounce } from './ui.js';

export function mountOptions(root, cfg) {
  const allMats = state.boot.materials.filter((m) => !cfg.allowed || cfg.allowed.includes(m.code));
  const opts = {
    material: cfg.defaults.material,
    color: cfg.defaults.color,
    scale: cfg.defaults.scale ?? 1,
    infill: cfg.defaults.infill ?? 35,
    quantity: 1,
  };
  const minScale = cfg.minScale ?? 0.2;
  let maxScale = cfg.maxScale ?? 3;
  let lastQuote = null;
  let ctrl = null;

  const mat = () => allMats.find((m) => m.code === opts.material) || allMats[0];
  const largest = () => Math.max(...cfg.baseSizeMm) * opts.scale;

  function render() {
    const m = mat();
    const color = m.colors.find((c) => c.code === opts.color) || m.colors[0];
    opts.color = color.code;
    root.innerHTML = String(html`
      <div class="opt">
        <div class="opt-label">${t('pdp.material')}<span>${tr(m.name)}</span></div>
        <div class="seg" role="group" aria-label="${t('pdp.material')}">${allMats.map((x) => html`<button type="button" data-mat="${x.code}" aria-pressed="${x.code === m.code}">${tr(x.name)}</button>`)}</div>
        <p class="small muted" style="margin:0">${tr(m.desc)}</p>
      </div>
      <div class="opt">
        <div class="opt-label">${t('pdp.color')}<span>${tr(color.name)}</span></div>
        <div class="swatches" role="group" aria-label="${t('pdp.color')}">${m.colors.map((c) => html`<button type="button" class="swatch" style="--c:${c.hex}" data-color="${c.code}" aria-pressed="${c.code === color.code}" title="${tr(c.name)}" aria-label="${tr(c.name)}"></button>`)}</div>
      </div>
      <div class="opt">
        <div class="opt-label">${t('pdp.size')}<span class="dims" data-dims>${dims(cfg.baseSizeMm.map((v) => v * opts.scale))}</span></div>
        <div class="size-row">
          <input type="range" data-scale min="${minScale}" max="${maxScale}" step="0.01" value="${opts.scale}" aria-label="${t('create.scale')}">
          <label class="mm-input small"><input class="input" type="number" data-mm min="5" step="1" value="${Math.round(largest())}" aria-label="${t('create.sizeMm')}">${t('common.mm')}</label>
        </div>
        <span class="tiny muted">${t('pdp.largest')} · <span data-pct>${num(opts.scale * 100)}%</span></span>
      </div>
      <div class="opt">
        <div class="opt-label">${t('pdp.infill')}<span data-infill-val>${opts.infill}%</span></div>
        <input type="range" data-infill min="${state.boot.infillRange?.[0] ?? 30}" max="${state.boot.infillRange?.[1] ?? 40}" step="5" value="${opts.infill}" aria-label="${t('pdp.infill')}">
        <span class="tiny muted">${t('pdp.infillHelp')}</span>
      </div>
      ${cfg.showQuantity !== false ? html`<div class="opt"><div class="opt-label">${t('pdp.quantity')}</div>
        <div class="qty"><button type="button" data-q="-1" aria-label="−">−</button><input data-qty inputmode="numeric" value="${opts.quantity}" aria-label="${t('pdp.quantity')}"><button type="button" data-q="1" aria-label="+">+</button></div></div>` : ''}
    `);
    bind();
  }

  function bind() {
    root.querySelectorAll('[data-mat]').forEach((b) => b.addEventListener('click', () => {
      opts.material = b.dataset.mat;
      const m = mat();
      if (!m.colors.some((c) => c.code === opts.color)) opts.color = m.colors[0].code;
      const [lo, hi] = state.boot.infillRange || [30, 40];
      opts.infill = Math.min(hi, Math.max(lo, opts.infill));
      render();
      changed();
    }));
    root.querySelectorAll('[data-color]').forEach((b) => b.addEventListener('click', () => {
      opts.color = b.dataset.color;
      root.querySelectorAll('[data-color]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      root.querySelector('.opt:nth-child(2) .opt-label span').textContent = b.title;
      changed();
    }));
    const scale = root.querySelector('[data-scale]');
    const mm = root.querySelector('[data-mm]');
    const syncSize = () => {
      root.querySelector('[data-dims]').textContent = dims(cfg.baseSizeMm.map((v) => v * opts.scale));
      root.querySelector('[data-pct]').textContent = `${num(opts.scale * 100)}%`;
    };
    scale.addEventListener('input', () => {
      opts.scale = Number(scale.value);
      mm.value = Math.round(largest());
      syncSize();
      changed();
    });
    mm.addEventListener('change', () => {
      const s = Math.min(maxScale, Math.max(minScale, Number(mm.value) / Math.max(...cfg.baseSizeMm)));
      opts.scale = Math.round(s * 1000) / 1000;
      scale.value = opts.scale;
      mm.value = Math.round(largest());
      syncSize();
      changed();
    });
    const infill = root.querySelector('[data-infill]');
    infill.addEventListener('input', () => {
      opts.infill = Number(infill.value);
      root.querySelector('[data-infill-val]').textContent = `${opts.infill}%`;
      changed();
    });
    const qty = root.querySelector('[data-qty]');
    if (qty) {
      const setQ = (v) => { opts.quantity = Math.min(50, Math.max(1, Math.round(v) || 1)); qty.value = opts.quantity; changed(); };
      root.querySelectorAll('[data-q]').forEach((b) => b.addEventListener('click', () => setQ(opts.quantity + Number(b.dataset.q))));
      qty.addEventListener('change', () => setQ(Number(qty.value)));
    }
  }

  const requote = debounce(async () => {
    ctrl?.abort();
    ctrl = new AbortController();
    cfg.receiptEl?.querySelector('.receipt')?.classList.add('loading');
    try {
      const q = await api('/api/quote', { method: 'POST', body: { ...cfg.quoteTarget(), ...opts, ...destQuery() }, signal: ctrl.signal });
      lastQuote = q;
      const bed = q.printability.checks.find((c) => c.id === 'bed');
      if (cfg.receiptEl) cfg.receiptEl.innerHTML = String(receipt(q));
      if (cfg.checksEl) {
        cfg.checksEl.innerHTML = String(html`${checksList(q.printability)}${bed?.status === 'fail' && bed.maxScale > minScale
          ? html`<button type="button" class="btn btn-sm" data-fit style="margin-top:8px">${t('check.maxSize')}</button>` : ''}`);
        cfg.checksEl.querySelector('[data-fit]')?.addEventListener('click', () => {
          opts.scale = Math.floor(bed.maxScale * 100) / 100;
          maxScale = Math.min(maxScale, opts.scale);
          render();
          changed();
        });
      }
      cfg.onQuote?.(q, opts);
    } catch (err) {
      if (err.name === 'AbortError') return;
      if (cfg.receiptEl) cfg.receiptEl.innerHTML = String(html`<div class="receipt"><p class="error-text">${err.message}</p></div>`);
      cfg.onQuote?.(null, opts, err);
    }
  }, 180);

  function changed() {
    cfg.onChange?.({ ...opts, colorHex: mat().colors.find((c) => c.code === opts.color)?.hex });
    requote();
  }

  render();
  changed();
  return {
    get: () => ({ ...opts }),
    quote: () => lastQuote,
    colorHex: () => mat().colors.find((c) => c.code === opts.color)?.hex,
    requote,
    setBase(sizeMm) { cfg.baseSizeMm = sizeMm; render(); changed(); },
  };
}

export { money, countryName, raw };
