import { sb, loadSessionUser } from '../api.js';
import { t, getLocale } from '../i18n.js';
import { state } from '../state.js';
import { html, toast, formData } from '../ui.js';
import { signedIn, navigate as go } from '../app.js';

const friendly = (msg) => {
  const m = String(msg || '');
  if (/invalid login credentials/i.test(m)) return t('auth.badLogin');
  if (/already registered|already exists/i.test(m)) return t('auth.emailTaken');
  if (/email not confirmed/i.test(m)) return t('auth.confirmEmail');
  if (/password should be at least|weak/i.test(m)) return t('auth.passwordHint');
  if (/rate limit|too many/i.test(m)) return t('auth.tooMany');
  return m;
};

export default async function auth(view, { path, query }) {
  const signup = path === '/signup';
  const next = query.next && query.next.startsWith('/') && !query.next.startsWith('//') ? query.next : '/';
  if (state.user) { go(next, { replace: true }); return; }
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
  </div></div>`);

  const form = view.querySelector('[data-auth]');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = view.querySelector('[data-error]');
    err.hidden = true;
    const btn = form.querySelector('button.btn-primary');
    btn.disabled = true;
    const f = formData(form);
    const email = String(f.email || '').trim().toLowerCase();
    try {
      if (signup) {
        const name = String(f.name || '').trim().slice(0, 80);
        if (name.length < 2) throw new Error(t('auth.nameRequired'));
        const { data, error } = await sb.auth.signUp({ email, password: f.password, options: { data: { name, locale: getLocale() } } });
        if (error) throw new Error(friendly(error.message));
        if (!data.session) {
          // Email confirmation is on in the project: tell the customer to check their inbox.
          view.querySelector('.auth-card').innerHTML = String(html`<h1 style="font-size:24px;margin-bottom:10px">${t('auth.checkInbox')}</h1><p class="muted">${t('auth.checkInboxHint', { email })}</p>
            <a class="btn btn-primary" style="margin-top:16px" href="/signin" data-link>${t('auth.signin')}</a>`);
          return;
        }
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password: f.password });
        if (error) throw new Error(friendly(error.message));
      }
      const user = await loadSessionUser({ fresh: true });
      if (user.disabled) { await sb.auth.signOut(); throw new Error(t('auth.disabled')); }
      await signedIn(user);
      go(user.role === 'admin' && next === '/' ? '/admin' : next, { replace: true });
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      btn.disabled = false;
    }
  });
  return () => {};
}

export { toast };
