// Manage dashboard shell: login, navigation, hash router.
// Pages live in ./pages/*; each exports render(view, params) and may return a cleanup function.

import { api, ApiError } from './api.js';
import { esc, $, icon, errorText, isDirty, setDirtyCheck, confirmDialog } from './ui.js';
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
  // The rail keeps its place; its content floats in one card, as tall as it needs and no taller.
  nav.innerHTML = `<div class="navcard"><a class="brand" href="#/"><img class="logo" src="${LOGO}" alt="">Manage</a>${NAV.map((n) =>
    n.group
      ? `<div class="grp">${esc(n.group)}</div>`
      : `<a href="${n.href}" class="${n.id === active ? 'on' : ''}" data-id="${n.id}">${esc(n.label)}</a>`
  ).join('')}
    <a class="ext" href="https://content.beyondmebtw.com" target="_blank" rel="noopener">Content server${icon('ext')}</a>
    <div class="foot"><button class="signout" id="logout" type="button">${icon('logout')}<span>Sign out</span></button></div></div>`;
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

// "I've been expecting you, Mr. Bond", the line everyone remembers that way, struck out for Mr. V.
// The strike-and-land plays on arrival; retries after a wrong password (and reduced motion) show the final line.
function showLogin(message) {
  cleanup();
  nav.classList.add('hidden');
  const animate = !message && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  view.innerHTML = `
    <section class="login ${animate ? 'animate' : ''}">
      <h1 class="bond">I’ve been expecting you, <span class="mr">Mr.&nbsp;<span class="was">Bond</span><span class="is">V.</span></span></h1>
      <form id="login-form" class="login-form">
        <input class="pw" type="password" name="password" aria-label="Password" placeholder="Password" autocomplete="current-password" required autofocus>
        <button class="go" type="submit" aria-label="Sign in">${icon('arrow')}</button>
      </form>
      <p class="login-msg" role="alert">${message ? esc(message) : ''}</p>
    </section>`;
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const go = $('.go', e.target);
    go.disabled = true;
    go.innerHTML = '<span class="spin"></span>';
    try {
      await api.login(String(new FormData(e.target).get('password')));
      if (continueAppLogin()) return;
      if (location.hash.startsWith('#/login')) location.hash = '#/';
      route();
    } catch (err) {
      showLogin(err.code === 'RATE_LIMITED' ? 'Too many attempts. Wait a bit and retry.' : 'Not this time.');
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
  const id = ++navId;
  if (!page) {
    view.classList.remove('navigating'); // an earlier, superseded navigation may have dimmed the view
    view.innerHTML = '<div class="page"><div class="empty big">Nothing here. <a href="#/">Back to the overview</a></div></div>';
    return;
  }
  // Render the next page off-screen and swap it in when ready: the current page stays (dimmed)
  // meanwhile instead of flashing to a blank "Loading…". Only the very first render shows a loader.
  const next = document.createElement('div');
  next.className = 'page';
  const outgoing = view.querySelector(':scope > .page');
  if (!outgoing) view.innerHTML = '<div class="loading"><span class="spin"></span>Loading…</div>';
  else {
    view.classList.add('navigating');
    outgoing.inert = true; // still visible while the next page loads, but nothing on it can act on stale data
  }
  let cleanupFn = null;
  try {
    cleanupFn = await page.render(next, parts, { reroute: route });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return showLogin();
    next.innerHTML = `<div class="banner bad">${errorText(err)}</div>`;
  }
  if (id !== navId) { if (typeof cleanupFn === 'function') cleanupFn(); return; } // a newer navigation won
  current = cleanupFn;
  view.classList.remove('navigating');
  const samePage = view.dataset.route === first;
  view.replaceChildren(next);
  view.dataset.route = first;
  if (!samePage) window.scrollTo(0, 0);
  window.dispatchEvent(new Event('resize')); // pages that measure themselves (photos canvas) re-fit once attached
}
let navId = 0;

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
