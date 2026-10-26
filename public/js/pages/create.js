import { api, qs } from '../api.js';
import { t, tr, isAr } from '../i18n.js';
import { state, destQuery } from '../state.js';
import { html, raw, money, num, toast, dims, esc, safetyNotice } from '../ui.js';
import { mountOptions } from '../options.js';
import { createViewer, webglAvailable } from '../viewer.js';
import { setCartCount, replaceUrl } from '../app.js';

const EXAMPLES = {
  en: ['a hexagonal pen holder shaped like a castle tower', 'a tall twisted vase', 'an owl figurine', 'a chess knight',
    'a star lamp shade', 'a faceted planter pot', 'a headphone stand', 'a trinket box with a lid'],
  ar: ['حامل أقلام سداسي على شكل برج قلعة', 'مزهرية طويلة ملتوية', 'مجسم بومة', 'حصان شطرنج',
    'أباجورة على شكل نجمة', 'أصيص مضلع', 'حامل سماعات', 'علبة حُلي بغطاء'],
};

export default async function create(view, { query }) {
  const lang = isAr() ? 'ar' : 'en';
  let designs = await api('/api/designs');
  let current = null;
  let viewer = null;
  let options = null;
  let polling = null;
  let disposed = false;

  view.innerHTML = String(html`<div class="wrap">
    <div style="padding-top:24px"><h1 style="font-size:30px">${t('create.title')}</h1><p class="muted" style="max-width:70ch;margin:6px 0 0">${t('create.lede')}</p></div>
    <div class="create">
      <div class="create-col left">
        <form class="panel opt" data-form>
          <label class="opt-label" for="prompt">${t('create.prompt')}</label>
          <textarea class="input" id="prompt" name="prompt" maxlength="600" rows="4" placeholder="${t('hero.placeholder')}">${query.prompt || ''}</textarea>
          <button class="btn btn-primary btn-block" data-generate>${t('create.generate')}</button>
          <button class="btn btn-block" type="button" data-regen hidden>${t('create.regenerate')}</button>
          <div class="opt" style="margin-top:6px"><span class="small muted">${t('create.examples')}</span>
            <div class="examples">${EXAMPLES[lang].map((e) => html`<button type="button" data-example="${e}">${e}</button>`)}</div></div>
        </form>
        <div class="panel opt" data-history-panel ${designs.length ? '' : raw('hidden')}>
          <div class="opt-label">${t('create.history')}</div>
          <div class="versions" data-versions></div>
          ${!state.user ? html`<p class="tiny muted" style="margin:0">${t('create.signinToSave')} <a href="/signin?next=/create" data-link>${t('nav.signin')}</a></p>` : ''}
        </div>
      </div>
      <div class="create-col">
        <div class="create-stage" data-stage>
          <div class="stage-empty" data-empty><div><h2>${t('create.empty')}</h2><p>${t('create.emptyHint')}</p></div></div>
          <div class="gen-overlay" data-overlay hidden><div><div class="layers"><i></i><i></i><i></i></div>
            <strong style="font-size:18px">${t('create.generating')}</strong><p class="small" style="color:#AEB7C1;max-width:36ch;margin:8px auto 0">${t('create.generatingHint')}</p>
            <div class="progress" style="width:200px;margin:14px auto 0;background:#3A434F"><i data-progress style="width:5%"></i></div></div></div>
          <div class="stage-bar" data-bar hidden><span class="pill" data-dims></span><span class="pill" data-provider></span></div>
        </div>
        <p class="tiny muted" style="margin:0">${t('create.privacy')}</p>
        ${safetyNotice(true)}
        <div data-title></div>
      </div>
      <div class="create-col" data-right hidden>
        <div class="panel buybox" data-options style="gap:16px"></div>
        <div class="panel" style="padding:14px 16px"><div class="opt-label" style="margin-bottom:8px">${t('pdp.printability')}</div><div data-checks></div></div>
        <div data-receipt></div>
        <button class="btn btn-primary btn-block" data-add style="min-height:50px">${t('pdp.add')}</button>
      </div>
    </div>
  </div>`);

  const form = view.querySelector('[data-form]');
  const ta = form.querySelector('textarea');
  const stage = view.querySelector('[data-stage]');
  const overlay = view.querySelector('[data-overlay]');
  const right = view.querySelector('[data-right]');

  view.querySelectorAll('[data-example]').forEach((b) => b.addEventListener('click', () => { ta.value = b.dataset.example; ta.focus(); }));

  function renderVersions() {
    const panel = view.querySelector('[data-history-panel]');
    panel.hidden = !designs.length;
    view.querySelector('[data-versions]').innerHTML = String(html`${designs.slice(0, 9).map((d) => html`<button type="button" data-design="${d.id}" aria-pressed="${current?.id === d.id}" title="${d.prompt}">
      ${d.thumb ? html`<img src="${d.thumb}" alt="">` : html`<span style="inset:0;display:grid;place-items:center;background:none">${d.status === 'failed' ? '!' : raw('<span class="spinner"></span>')}</span>`}</button>`)}`);
    view.querySelectorAll('[data-design]').forEach((b) => b.addEventListener('click', () => select(designs.find((d) => d.id === b.dataset.design))));
  }

  async function select(d) {
    current = d;
    replaceUrl(`/create${qs({ d: d.id })}`);
    ta.value = d.prompt;
    renderVersions();
    view.querySelector('[data-regen]').hidden = false;
    view.querySelector('[data-empty]').hidden = true;
    if (d.status === 'generating') return startPolling(d.id);
    overlay.hidden = true;
    if (d.status === 'failed') {
      right.hidden = true;
      view.querySelector('[data-bar]').hidden = true;
      view.querySelector('[data-title]').innerHTML = String(html`<div class="panel"><h3>${t('create.failed')}</h3><p class="muted small" style="margin:6px 0 0">${d.error}</p></div>`);
      viewer?.dispose(); viewer = null;
      return;
    }
    // Ready: show the protected preview and the buying options.
    view.querySelector('[data-title]').innerHTML = String(html`<h2 style="font-size:22px">${tr(d.title)}</h2>`);
    view.querySelector('[data-bar]').hidden = false;
    view.querySelector('[data-provider]').textContent = t('create.provider', { name: d.provider === 'demo' ? 'Prompt2Print' : `Prompt2Print · ${d.provider}` });
    right.hidden = false;
    if (webglAvailable()) {
      if (!viewer) viewer = createViewer(stage, { theme: 'dark' });
      await viewer.load(d.modelId, { color: state.boot.materials[0]?.colors[0]?.hex || '#1E1F22', material: 'ABS' });
      viewer.setScale(1, true);
    } else {
      view.querySelector('[data-empty]').hidden = false;
      view.querySelector('[data-empty]').innerHTML = String(html`<img src="${d.thumb}" alt="" style="max-height:100%">`);
    }
    const pla = state.boot.materials.find((m) => m.code === 'ABS') || state.boot.materials[0];
    options = mountOptions(view.querySelector('[data-options]'), {
      defaults: { material: pla.code, color: pla.colors[0].code, scale: 1, infill: 35 },
      minScale: 0.2,
      maxScale: 3,
      baseSizeMm: d.analysis.sizeMm,
      quoteTarget: () => ({ designId: d.id }),
      receiptEl: view.querySelector('[data-receipt]'),
      checksEl: view.querySelector('[data-checks]'),
      onChange: (o) => {
        viewer?.setColor(o.colorHex);
        viewer?.setMaterial(o.material);
        viewer?.setScale(o.scale);
        view.querySelector('[data-dims]').textContent = dims(d.analysis.sizeMm.map((v) => v * o.scale));
      },
      onQuote: (q) => {
        const add = view.querySelector('[data-add]');
        add.disabled = !q || !q.printability.ok || !q.shipsToDestination;
        add.title = q && !q.printability.ok ? t('create.notPrintable') : '';
      },
    });
  }

  function startPolling(id) {
    clearInterval(polling);
    overlay.hidden = false;
    right.hidden = true;
    view.querySelector('[data-bar]').hidden = true;
    const bar = view.querySelector('[data-progress]');
    polling = setInterval(async () => {
      try {
        const d = await api(`/api/designs/${id}`);
        if (disposed) return;
        bar.style.width = `${Math.max(5, d.progress)}%`;
        if (d.status !== 'generating') {
          clearInterval(polling);
          designs = [d, ...designs.filter((x) => x.id !== d.id)];
          if (current?.id === id) select(d);
          else renderVersions();
        }
      } catch { /* keep polling */ }
    }, 1000);
  }

  async function generate(prompt, regenerate = false) {
    const btns = view.querySelectorAll('[data-generate], [data-regen]');
    btns.forEach((b) => { b.disabled = true; });
    try {
      const d = regenerate
        ? await api(`/api/designs/${current.id}/regenerate`, { method: 'POST' })
        : await api('/api/designs', { method: 'POST', body: { prompt, parentId: current?.id, locale: isAr() ? 'ar' : 'en' } });
      designs = [d, ...designs];
      current = d;
      view.querySelector('[data-empty]').hidden = true;
      renderVersions();
      replaceUrl(`/create${qs({ d: d.id })}`);
      startPolling(d.id);
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btns.forEach((b) => { b.disabled = false; });
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const prompt = ta.value.trim();
    if (!prompt) { ta.focus(); return; }
    generate(prompt);
  });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) form.requestSubmit(); });
  view.querySelector('[data-regen]').addEventListener('click', () => current && generate(current.prompt, true));

  view.querySelector('[data-add]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const cart = await api('/api/cart/items', { method: 'POST', body: { designId: current.id, ...options.get(), ...destQuery() } });
      setCartCount(cart.count);
      toast(t('pdp.added'));
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  });

  renderVersions();
  const initial = query.d ? designs.find((d) => d.id === query.d) || (await api(`/api/designs/${query.d}`).catch(() => null)) : null;
  if (initial) select(initial);
  else if (query.prompt) {
    let auto = null;
    try { auto = sessionStorage.getItem('p2p_autogen'); sessionStorage.removeItem('p2p_autogen'); } catch { /* ignore */ }
    if (auto === query.prompt) generate(query.prompt);
  }

  return () => { disposed = true; clearInterval(polling); viewer?.dispose(); };
}

export { money, num, esc };
