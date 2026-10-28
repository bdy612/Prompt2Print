import { api, qs } from '../api.js';
import { t, tr, isAr } from '../i18n.js';
import { state, destQuery } from '../state.js';
import { html, productCard, num, raw } from '../ui.js';
import { loadViewer, webglAvailable } from '../viewer-loader.js';

// Catalog items shown printing in the hero, with the prompt that made them.
const HERO = [
  { slug: 'castle-tower-pen-holder', en: 'a hexagonal pen holder shaped like a castle tower', ar: 'حامل أقلام سداسي على شكل برج قلعة' },
  { slug: 'spiral-vase', en: 'a tall twisted vase for dried flowers', ar: 'مزهرية طويلة ملتوية للزهور المجففة' },
  { slug: 'chess-knight', en: 'a chess knight with a flowing mane', ar: 'حصان شطرنج بعُرف منسدل' },
  { slug: 'owl-figurine', en: 'a round little owl with big eyes', ar: 'بومة صغيرة مستديرة بعينين كبيرتين' },
];

const EXAMPLES = {
  en: ['a lamp shade with star cut-outs', 'a honeycomb pen holder', 'a twisted vase 20 cm tall', 'a chess queen', 'a headphone stand'],
  ar: ['أباجورة على شكل نجمة', 'حامل أقلام سداسي', 'مزهرية ملتوية بطول 20 سم', 'وزير شطرنج', 'حامل سماعات'],
};

export default async function home(view, { navigate }) {
  const [featured, best] = await Promise.all([
    api(`/api/products${qs({ featured: 1, limit: 8, ...destQuery() })}`),
    api(`/api/products${qs({ sort: 'bestselling', limit: 8, ...destQuery() })}`),
  ]);
  const lang = isAr() ? 'ar' : 'en';

  view.innerHTML = String(html`
  <section class="hero">
    <div class="wrap">
      <div>
        <h1>${t('hero.title')}</h1>
        <p class="lede">${t('hero.lede')}</p>
        <form class="prompt-box" data-prompt>
          <label class="sr" for="hero-prompt">${t('create.prompt')}</label>
          <textarea id="hero-prompt" name="prompt" rows="2" maxlength="600" placeholder="${t('hero.placeholder')}"></textarea>
          <button class="btn btn-primary" type="submit">${t('hero.cta')}</button>
        </form>
        <div class="prompt-chips">${EXAMPLES[lang].map((e) => html`<button class="chip" type="button" data-example="${e}">${e}</button>`)}</div>
      </div>
      <div class="hero-stage" data-stage>
        <div class="hero-caption"><div><q data-hero-prompt></q><div class="print-meter"><i data-meter></i></div></div><span class="num" data-layer></span></div>
      </div>
    </div>
  </section>

  <section class="section wrap">
    <div class="section-head"><h2>${t('home.categories')}</h2><a href="/search" data-link>${t('home.seeAll')}</a></div>
    <div class="cat-row">${state.boot.categories.map((c) => html`<a class="cat-tile" href="/c/${c.slug}" data-link>
      ${c.cover ? html`<img src="${c.cover}" alt="" loading="lazy" width="200" height="200">` : html`<img alt="">`}<span>${tr(c.name)}</span><small>${num(c.count)}</small></a>`)}</div>
  </section>

  <section class="section wrap">
    <div class="section-head"><h2>${t('home.featured')}</h2><a href="/search?sort=featured" data-link>${t('home.seeAll')}</a></div>
    ${featured.items.length ? html`<div class="grid">${featured.items.map(productCard)}</div>` : html`<p class="muted">${t('search.none')}</p>`}
  </section>

  <section class="section wrap">
    <div class="section-head"><h2>${t('home.best')}</h2><a href="/search?sort=bestselling" data-link>${t('home.seeAll')}</a></div>
    ${best.items.length ? html`<div class="grid">${best.items.map(productCard)}</div>` : html`<p class="muted">${t('search.none')}</p>`}
  </section>`);

  // Prompt box
  const form = view.querySelector('[data-prompt]');
  const ta = form.querySelector('textarea');
  const grow = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(140, ta.scrollHeight)}px`; };
  ta.addEventListener('input', grow);
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const prompt = ta.value.trim() || ta.placeholder;
    // Only a prompt typed here starts generating right away; a shared /create?prompt= link just fills the box.
    try { sessionStorage.setItem('p2p_autogen', prompt); } catch { /* ignore */ }
    navigate(`/create${qs({ prompt })}`);
  });
  view.querySelectorAll('[data-example]').forEach((b) => b.addEventListener('click', () => { ta.value = b.dataset.example; grow(); ta.focus(); }));

  // Hero: catalog models printing layer by layer.
  const stage = view.querySelector('[data-stage]');
  let viewer = null;
  let stopped = false;
  if (webglAvailable()) (async () => {
    viewer = (await loadViewer()).createViewer(stage, { theme: 'dark', autoRotate: false, interactive: true });
    if (stopped) { viewer.dispose(); return; }
    const items = (await Promise.all(HERO.map((h) => api(`/api/products/${h.slug}`).then((p) => ({ ...h, p })).catch(() => null)))).filter(Boolean);
    const promptEl = view.querySelector('[data-hero-prompt]');
    const meter = view.querySelector('[data-meter]');
    const layerEl = view.querySelector('[data-layer]');
    (async () => {
      for (let i = 0; !stopped && items.length; i = (i + 1) % items.length) {
        const it = items[i];
        // Hero prints always use our magenta filament.
        await viewer.load(it.p.modelId, { color: '#D6246E', material: 'ABS' });
        if (stopped) return;
        promptEl.textContent = it[lang];
        viewer.setAutoRotate(false);
        const total = Math.round(it.p.analysis.sizeMm[2] / 0.2);
        await viewer.printAnimation({
          duration: 6500,
          onProgress: (p) => { meter.style.width = `${p * 100}%`; layerEl.textContent = `${t('hero.layer')} ${num(Math.round(p * total))} / ${num(total)}`; },
        });
        viewer.setAutoRotate(true);
        await new Promise((r) => setTimeout(r, 3800));
      }
    })();
  })().catch(() => {});
  return () => { stopped = true; viewer?.dispose(); };
}

export { raw };
