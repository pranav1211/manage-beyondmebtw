// Manage dashboard shell: login, navigation, hash router.
// Pages live in ./pages/*; each exports render(view, params) and may return a cleanup function.

import { api, ApiError } from './api.js';
import { esc, $, errorText, isDirty, setDirtyCheck, confirmDialog } from './ui.js';
import * as overview from './pages/overview.js';
import * as home from './pages/home.js';
import * as blog from './pages/blog.js';
import * as projects from './pages/projects.js';
import * as photos from './pages/photos.js';
import * as minis from './pages/minis.js';
import * as apps from './pages/apps.js';
import * as data from './pages/data.js';

const LOGO = 'https://content.beyondmebtw.com/assets/bmb_logos/BMB_Logo_wb.png';
const view = $('#view');
const nav = $('#nav');

const NAV = [
  { group: 'Content' },
  { id: 'overview', label: 'Overview', href: '#/' },
  { id: 'home', label: 'Homepage', href: '#/home' },
  { id: 'blog', label: 'Blog', href: '#/blog' },
  { id: 'projects', label: 'Projects', href: '#/projects' },
  { id: 'photos', label: 'Photos', href: '#/photos' },
  { id: 'minis', label: 'Minis', href: '#/minis' },
  { group: 'System' },
  { id: 'apps', label: 'Apps & deploys', href: '#/apps' },
  { id: 'data', label: 'Data', href: '#/data' }
];

const ROUTES = {
  '': overview,
  home,
  blog,
  categories: blog,
  projects,
  photos,
  minis,
  apps,
  ops: apps,
  reconcile: apps,
  registry: apps,
  data
};

function drawNav(active) {
  nav.innerHTML = `<a class="brand" href="#/"><img class="logo" src="${LOGO}" alt="">Manage</a>${NAV.map((n) =>
    n.group
      ? `<div class="grp">${esc(n.group)}</div>`
      : `<a href="${n.href}" class="${n.id === active ? 'on' : ''}" data-id="${n.id}">${esc(n.label)}</a>`
  ).join('')}<div class="foot"><button class="linkbtn" id="logout" type="button">Sign out</button></div>`;
  $('#logout').addEventListener('click', async () => {
    if (isDirty() && !(await confirmDialog('Unsaved changes', 'Sign out and lose your unsaved changes?', { confirmLabel: 'Sign out', danger: true }))) return;
    await api.logout().catch(() => {});
    setDirtyCheck(null);
    showLogin();
  });
}

const navIdFor = (first) => ({ '': 'overview', categories: 'blog', ops: 'apps', reconcile: 'apps', registry: 'apps' })[first] ?? first;

// ── login ──
// "Sign in with Manage": an app sent the browser here (#/login?next=/api/v1/auth/app-login?...).
// Once signed in, continue to that URL, and ONLY to Manage's own app-login path.
function continueAppLogin() {
  const m = /^#\/login\?next=(.+)$/.exec(location.hash);
  if (!m) return false;
  let next;
  try {
    next = decodeURIComponent(m[1]);
  } catch {
    return false;
  }
  if (!next.startsWith('/api/v1/auth/app-login?')) return false;
  location.replace(next);
  return true;
}

function showLogin(message) {
  cleanup();
  nav.classList.add('hidden');
  view.innerHTML = `
    <section class="login">
      <img class="login-logo" src="${LOGO}" alt="Beyond Me">
      <h1>Manage</h1>
      <p class="sub">Beyond Me control panel</p>
      ${message ? `<div class="banner bad">${esc(message)}</div>` : ''}
      <form id="login-form" class="login-form">
        <label class="f"><span>Admin password</span><input class="in" type="password" name="password" autocomplete="current-password" required autofocus></label>
        <button class="btn primary wide" type="submit">Sign in</button>
      </form>
    </section>`;
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api.login(String(new FormData(e.target).get('password')));
      if (continueAppLogin()) return;
      if (location.hash.startsWith('#/login')) location.hash = '#/';
      route();
    } catch (err) {
      showLogin(err.code === 'RATE_LIMITED' ? 'Too many attempts. Wait a bit and retry.' : 'Sign-in failed.');
    }
  });
}

// ── router ──
let current = null; // cleanup function of the current page
let lastHash = location.hash;
let skipGuard = false;

function cleanup() {
  if (typeof current === 'function') current();
  current = null;
  setDirtyCheck(null);
}

export async function route() {
  const h = location.hash.replace(/^#\/?/, '');
  if (h.startsWith('login')) return showLogin();
  const parts = h.split('?')[0].split('/').map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
  const first = parts[0] || '';
  const page = ROUTES[first];
  nav.classList.remove('hidden');
  drawNav(navIdFor(first));
  cleanup();
  if (!page) {
    view.innerHTML = '<div class="empty big">Nothing here. <a href="#/">Back to the overview</a></div>';
    return;
  }
  view.innerHTML = '<div class="loading"><span class="spin"></span>Loading…</div>';
  window.scrollTo(0, 0);
  try {
    current = await page.render(view, parts, { reroute: route });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return showLogin();
    view.innerHTML = `<div class="banner bad">${errorText(err)}</div>`;
  }
}

window.addEventListener('hashchange', async () => {
  if (skipGuard) { skipGuard = false; lastHash = location.hash; return; }
  if (isDirty()) {
    const target = location.hash;
    skipGuard = true;
    history.replaceState(null, '', lastHash || '#/');
    skipGuard = false;
    const leave = await confirmDialog('Unsaved changes', 'You have changes that are not saved yet. Leave this page and lose them?', { confirmLabel: 'Leave without saving', danger: true });
    if (!leave) return;
    setDirtyCheck(null);
    skipGuard = true;
    location.hash = target;
    lastHash = target;
    route();
    return;
  }
  lastHash = location.hash;
  route();
});

(async function boot() {
  try {
    const s = await api.session();
    if (!s.authenticated) return showLogin();
    if (continueAppLogin()) return;
    route();
  } catch {
    showLogin();
  }
})();
