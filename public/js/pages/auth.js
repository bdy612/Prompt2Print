import { api } from '../api.js';
import { t, getLocale } from '../i18n.js';
import { state } from '../state.js';
import { html, toast, formData } from '../ui.js';
import { signedIn, navigate as go } from '../app.js';

export default async function auth(view, { path, query }) {
  const signup = path === '/signup';
  const next = query.next && query.next.startsWith('/') && !query.next.startsWith('//') ? query.next : '/';
  if (state.user) { go(next, { replace: true }); return; }
  if (!signup && state.boot.adminSetupNeeded) return setupAdmin(view);
  const showDemo = state.boot.demo;
  view.innerHTML = String(html`<div class="wrap"><div class="panel auth-card">
    <h1 style="font-size:26px;margin-bottom:16px">${signup ? t('auth.signup') : t('auth.signin')}</h1>
    <form data-auth style="display:grid;gap:14px">
      ${signup ? html`<label class="field">${t('auth.name')}<input class="input" name="name" required autocomplete="name"></label>` : ''}
      <label class="field">${t('auth.email')}<input class="input" type="email" name="email" required autocomplete="email" dir="ltr"></label>
      <label class="field">${t('auth.password')}<input class="input" type="password" name="password" required minlength="${signup ? 8 : 1}" autocomplete="${signup ? 'new-password' : 'current-password'}" dir="ltr">
        ${signup ? html`<span class="hint">${t('auth.passwordHint')}</span>` : ''}</label>
      <p class="error-text" data-error hidden></p>
      <button class="btn btn-primary btn-block">${signup ? t('auth.signup') : t('auth.signin')}</button>
    </form>
    <p class="small" style="margin:16px 0 0">${signup ? t('auth.haveAccount') : t('auth.noAccount')}
      <a href="${signup ? '/signin' : '/signup'}${query.next ? `?next=${encodeURIComponent(next)}` : ''}" data-link>${signup ? t('auth.signin') : t('auth.signup')}</a></p>
    ${showDemo && !signup ? html`<div class="demo-box"><strong>${t('auth.demo')}</strong><br>
      <button type="button" data-demo="demo@prompt2print.local" data-pw="Demo#2026">demo@prompt2print.local</button> · Demo#2026<br>
      <button type="button" data-demo="admin@prompt2print.local" data-pw="Admin#2026">admin@prompt2print.local</button> · Admin#2026</div>` : ''}
  </div></div>`);

  const form = view.querySelector('[data-auth]');
  view.querySelectorAll('[data-demo]').forEach((b) => b.addEventListener('click', () => {
    form.email.value = b.dataset.demo;
    form.password.value = b.dataset.pw;
    form.requestSubmit();
  }));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = view.querySelector('[data-error]');
    err.hidden = true;
    const btn = form.querySelector('button.btn-primary');
    btn.disabled = true;
    try {
      const res = await api(signup ? '/api/auth/signup' : '/api/auth/login', { method: 'POST', body: { ...formData(form), locale: getLocale() } });
      await signedIn(res.user);
      go(res.user.role === 'admin' && next === '/' ? '/admin' : next, { replace: true });
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      btn.disabled = false;
    }
  });
  return () => {};
}

// First start: the admin account has no password yet; the owner sets it from this computer.
function setupAdmin(view) {
  view.innerHTML = String(html`<div class="wrap"><div class="panel auth-card">
    <h1 style="font-size:26px;margin-bottom:8px">${t('auth.setupTitle')}</h1>
    <p class="muted small" style="margin-bottom:16px">${t('auth.setupHint')}</p>
    <form data-setup style="display:grid;gap:14px">
      <label class="field">${t('auth.email')}<input class="input" type="email" value="${state.boot.adminEmail || ''}" readonly dir="ltr"></label>
      <label class="field">${t('auth.password')}<input class="input" type="password" name="password" required minlength="10" autocomplete="new-password" dir="ltr">
        <span class="hint">${t('auth.setupHintPw')}</span></label>
      <label class="field">${t('auth.setupConfirm')}<input class="input" type="password" name="confirm" required minlength="10" autocomplete="new-password" dir="ltr"></label>
      <p class="error-text" data-error hidden></p>
      <button class="btn btn-primary btn-block">${t('auth.setupButton')}</button>
    </form>
  </div></div>`);
  const form = view.querySelector('[data-setup]');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = view.querySelector('[data-error]');
    err.hidden = true;
    const { password, confirm } = formData(form);
    if (password !== confirm) { err.textContent = t('auth.setupMismatch'); err.hidden = false; return; }
    const btn = form.querySelector('button.btn-primary');
    btn.disabled = true;
    try {
      const res = await api('/api/auth/setup-admin', { method: 'POST', body: { password } });
      await signedIn(res.user);
      go('/admin', { replace: true });
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      btn.disabled = false;
    }
  });
  return () => {};
}

export { toast };
