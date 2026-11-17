// Shared UI helpers: escaping, icons, toasts, dialogs, save feedback, guards.
// Every value from the API is escaped before it reaches innerHTML.

import { ApiError } from './api.js';

export const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// For use inside double-quoted style="" attributes: percent-encode anything that could end url() or the attribute.
export const cssUrl = (u) =>
  u ? `url('${String(u).replace(/[\s'"()\\<>]/g, (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))}')` : 'none';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ICONS = {
  plus: 'M12 5v14M5 12h14',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
  ext: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  star: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z',
  up: 'M12 19V5M5 12l7-7 7 7',
  down: 'M12 5v14M5 12l7 7 7-7',
  x: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12l5 5L20 7',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5',
  image: 'M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6M15.5 9.5h.01',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  copy: 'M9 9h11v11H9zM5 15V4h11',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11',
  arrow: 'M5 12h14M13 6l6 6-6 6'
};
export const icon = (name, cls = 'i') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[name] || ''}"/></svg>`;

export const badge = (state, label) => `<span class="badge s-${esc(String(state).toLowerCase())}">${esc(label ?? state)}</span>`;
export const time = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
export function ago(iso) {
  if (!iso) return '—';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}
export const json = (v) => `<pre class="json">${esc(JSON.stringify(v, null, 2))}</pre>`;
export const short = (sha) => (sha ? String(sha).slice(0, 7) : '');

/** "Jan 18, 2025" or "2025-01-18" -> "2025-01-18" (local date), '' if unparseable. */
export function isoDate(s) {
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
export const todayISO = () => isoDate(new Date().toString());
export const prettyDate = (s) => {
  const iso = isoDate(s);
  return iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : String(s || '');
};

// ── activity status (top centre): "working…" while something runs, then the result ──
let statusTimer;
let busyDepth = 0;
function statusEl() {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  return el;
}
// The "working" state is held for at least MIN_WORK_MS so a fast save is seen as
// "Saving… → ✓ Saved" rather than a flicker, shows elapsed seconds while it runs (a GitHub
// push takes a few seconds), and says so if something runs unusually long.
const MIN_WORK_MS = 650;
let workStartedAt = 0;
let workTicker = null;
let showSeq = 0;
let pendingShow = null;
function stopTicker() { if (workTicker) { clearInterval(workTicker); workTicker = null; } }

/** Show "label" with a spinner until a result (toast) replaces it. */
export function working(label) {
  const el = statusEl();
  clearTimeout(statusTimer);
  clearTimeout(pendingShow);
  stopTicker();
  showSeq += 1;
  workStartedAt = Date.now();
  el.className = 'toast show t-work';
  el.innerHTML = `<span class="spin"></span><span>${esc(label)}</span><span class="elapsed"></span>`;
  workTicker = setInterval(() => {
    const s = Math.floor((Date.now() - workStartedAt) / 1000);
    const e = el.querySelector('.elapsed');
    if (!e) return stopTicker();
    if (s >= 2) e.textContent = `${s}s`;
    if (s >= 25) e.textContent = `${s}s · taking longer than usual, still working`;
  }, 500);
}
/** The result of an action (or any message). kind: ok | warn | bad */
export function toast(msg, kind = 'ok') {
  const el = statusEl();
  const seq = ++showSeq;
  clearTimeout(pendingShow);
  const wait = el.classList.contains('t-work') ? Math.max(0, MIN_WORK_MS - (Date.now() - workStartedAt)) : 0;
  pendingShow = setTimeout(() => {
    if (seq !== showSeq) return; // a newer message took over
    stopTicker();
    clearTimeout(statusTimer);
    el.className = `toast show t-${kind}`;
    el.innerHTML = `<span class="ico">${kind === 'ok' ? icon('check') : kind === 'bad' ? icon('x') : '!'}</span><span>${msg}</span>`;
    statusTimer = setTimeout(() => el.classList.remove('show'), kind === 'bad' ? 7000 : 3600);
  }, wait);
}
/** Hide a lingering "working" state that no result replaced (e.g. a dialog took over). */
function clearWorking() {
  const seq = showSeq;
  const wait = Math.max(0, MIN_WORK_MS - (Date.now() - workStartedAt));
  setTimeout(() => {
    if (seq !== showSeq || busyDepth) return;
    const el = $('#toast');
    if (el && el.classList.contains('t-work')) { stopTicker(); el.classList.remove('show'); }
  }, wait);
}
// Any write the API makes shows activity, even when it isn't wrapped in busy().
window.addEventListener('manage:write', (e) => {
  if (e.detail === 'start' && !busyDepth) working('Saving…');
  // If no result message follows the write within a moment, don't leave "Saving…" up.
  if (e.detail === 'end' && !busyDepth) setTimeout(clearWorking, 800);
});
// Thin progress bar while any request is in flight (shown after a short delay, so quick ones don't flash).
let barTimer;
window.addEventListener('manage:net', (e) => {
  let bar = $('#progress');
  if (!bar) { bar = document.createElement('div'); bar.id = 'progress'; document.body.appendChild(bar); }
  clearTimeout(barTimer);
  if (e.detail > 0) barTimer = setTimeout(() => bar.classList.add('on'), 120);
  else bar.classList.remove('on');
});

// ── dialogs ──
/**
 * Opens a modal. actions: [{ label, value, kind: 'primary'|'danger'|'', disabledUntilTyped }]
 * Resolves with the clicked action's value (or null on Esc / backdrop). `onOpen(el)` can wire up the body.
 */
export function modal({ title, body = '', actions = [{ label: 'Close', value: null }], wide = false, typed = null, onOpen }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="modal-h"><h2>${esc(title)}</h2><button class="iconbtn" data-close aria-label="Close">${icon('x')}</button></div>
      <div class="modal-b">${body}${typed ? `<label class="f"><span>Type <code>${esc(typed)}</code> to confirm</span><input class="in" data-typed autocomplete="off"></label>` : ''}</div>
      <div class="modal-f">${actions.map((a, i) => `<button class="btn ${a.kind || ''}" data-i="${i}" ${typed && a.kind === 'danger' ? 'disabled' : ''}>${esc(a.label)}</button>`).join('')}</div>
    </div>`;
    const done = (v) => {
      document.removeEventListener('keydown', onKey);
      wrap.remove();
      resolve(v);
    };
    const onKey = (e) => { if (e.key === 'Escape') done(null); };
    document.addEventListener('keydown', onKey);
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) done(null); });
    $('[data-close]', wrap).addEventListener('click', () => done(null));
    $$('[data-i]', wrap).forEach((b) => b.addEventListener('click', () => done(actions[+b.dataset.i].value)));
    if (typed) {
      const inp = $('[data-typed]', wrap);
      inp.addEventListener('input', () => $$('.btn.danger', wrap).forEach((b) => { b.disabled = inp.value.trim() !== typed; }));
    }
    document.body.appendChild(wrap);
    if (onOpen) onOpen($('.modal', wrap), done);
    const first = $('input,select,textarea', $('.modal-b', wrap)) || $('.btn.primary,.btn.danger', wrap);
    if (first) setTimeout(() => first.focus(), 30);
  });
}

/**
 * Searchable picker. items: [{ id, html, text }] (text is what search matches).
 * Resolves with the chosen id, or null.
 */
export function pick({ title, items, placeholder = 'Search…', empty = 'Nothing to pick from.' }) {
  return modal({
    title,
    wide: true,
    body: `<input class="in" data-q placeholder="${esc(placeholder)}" style="margin-bottom:10px"><div class="picker-list list" data-l></div>`,
    actions: [{ label: 'Cancel', value: null }],
    onOpen: (el, done) => {
      const list = $('[data-l]', el);
      const draw = (q) => {
        const s = q.trim().toLowerCase();
        const shown = items.filter((it) => !s || String(it.text || '').toLowerCase().includes(s)).slice(0, 200);
        list.innerHTML = shown.length ? shown.map((it, i) => `<div class="li" data-k="${i}" tabindex="0">${it.html}</div>`).join('') : `<div class="empty">${esc(empty)}</div>`;
        $$('[data-k]', list).forEach((row) => {
          const choose = () => done(shown[+row.dataset.k].id);
          row.addEventListener('click', choose);
          row.addEventListener('keydown', (e) => { if (e.key === 'Enter') choose(); });
        });
      };
      $('[data-q]', el).addEventListener('input', (e) => draw(e.target.value));
      draw('');
    }
  });
}

/** Small form in a dialog. fields: [{ name, label, value, type: 'text'|'textarea'|'date'|'url', required }]. Resolves with values or null. */
export function formDialog({ title, fields, submitLabel = 'Apply' }) {
  let values = null;
  return modal({
    title,
    wide: true,
    body: `<form data-form>${fields.map((f) => `<label class="f"><span>${esc(f.label)}</span>${f.type === 'textarea'
      ? `<textarea class="in" name="${esc(f.name)}" rows="4">${esc(f.value)}</textarea>`
      : `<input class="in" name="${esc(f.name)}" type="${f.type === 'date' ? 'date' : 'text'}" value="${esc(f.value)}" ${f.required ? 'required' : ''}>`}${f.hint ? `<div class="hint">${esc(f.hint)}</div>` : ''}</label>`).join('')}</form>`,
    actions: [{ label: 'Cancel', value: false }, { label: submitLabel, value: true, kind: 'primary' }],
    onOpen: (el, done) => {
      const form = $('[data-form]', el);
      const collect = () => { values = Object.fromEntries(new FormData(form)); };
      form.addEventListener('input', collect);
      form.addEventListener('submit', (e) => { e.preventDefault(); collect(); done(true); });
      collect();
    }
  }).then((ok) => (ok ? values : null));
}

export const confirmDialog = (title, message, { confirmLabel = 'Confirm', danger = false, typed = null } = {}) =>
  modal({
    title,
    body: `<p class="lead">${message}</p>`,
    typed,
    actions: [{ label: 'Cancel', value: false }, { label: confirmLabel, value: true, kind: danger ? 'danger' : 'primary' }]
  }).then(Boolean);

// ── save feedback ──
export function savedMessage(res, what = 'Saved') {
  const p = (res && res.persistence) || {};
  if (p.status === 'noop') return { text: 'No changes to save', kind: 'ok' };
  if (p.pending) return { text: `${what}, but <b>not pushed to GitHub yet</b>. Manage will keep it; retry from Data.`, kind: 'warn' };
  return { text: `${what} · pushed to bmb-data${p.commit ? ` <code>${esc(short(p.commit))}</code>` : ''}`, kind: 'ok' };
}
export const toastSaved = (res, what) => { const m = savedMessage(res, what); toast(m.text, m.kind); };

export function errorText(err) {
  if (!(err instanceof ApiError)) return esc(err && err.message ? err.message : 'Unexpected error');
  const extra = err.details && err.details.errors ? ` (${esc(err.details.errors.map((e) => `${e.path || ''} ${e.message}`).join('; '))})` : '';
  return `<b>${esc(err.code)}</b> ${esc(err.message)}${extra}`;
}

/**
 * Standard handling for a failed save. A CONFLICT means someone (or an app) changed the
 * document since this page loaded: offer to reload rather than overwrite.
 */
export async function saveFailed(err, reload) {
  if (err instanceof ApiError && err.status === 401) { location.reload(); return; }
  if (err instanceof ApiError && err.code === 'CONFLICT' && reload) {
    const v = await modal({
      title: 'Changed somewhere else',
      body: '<p class="lead">This was changed since you opened it (another tab, an app, or a push to bmb-data). Nothing was saved.</p><p>Reload to get the latest version. Your unsaved edits on this page will be lost.</p>',
      actions: [{ label: 'Keep editing', value: false }, { label: 'Reload latest', value: true, kind: 'primary' }]
    });
    if (v) reload();
    return;
  }
  toast(errorText(err), 'bad');
}

/** Disable a button while `promise` runs; show a label meanwhile. */
export async function busy(btn, label, fn) {
  const old = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spin"></span>${esc(label)}`; }
  busyDepth += 1;
  working(`${label}…`);
  try {
    return await fn();
  } finally {
    busyDepth -= 1;
    if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = old; }
    // No result message replaced the "working" state (e.g. a dialog took over): clear it.
    if (!busyDepth) clearWorking();
  }
}

// ── unsaved-changes guard ──
let dirtyCheck = null;
export const setDirtyCheck = (fn) => { dirtyCheck = fn; };
export const isDirty = () => Boolean(dirtyCheck && dirtyCheck());
window.addEventListener('beforeunload', (e) => {
  if (isDirty()) { e.preventDefault(); e.returnValue = ''; }
});

// ── drag to reorder ──
/** Rows matching `selector` inside `container` become draggable; onMove(fromIndex, toIndex). */
export function sortable(container, selector, onMove, { handle = null } = {}) {
  let from = -1;
  const rows = () => $$(selector, container);
  rows().forEach((row, i) => {
    row.setAttribute('draggable', 'true');
    if (handle) row.addEventListener('mousedown', (e) => { row.setAttribute('draggable', String(Boolean(e.target.closest(handle)))); });
    row.addEventListener('dragstart', (e) => { from = i; row.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', String(i)); } catch { /* old browsers */ } });
    row.addEventListener('dragend', () => { row.classList.remove('dragging'); rows().forEach((r) => r.classList.remove('drop')); });
    row.addEventListener('dragover', (e) => { e.preventDefault(); if (i !== from) row.classList.add('drop'); });
    row.addEventListener('dragleave', () => row.classList.remove('drop'));
    row.addEventListener('drop', (e) => { e.preventDefault(); row.classList.remove('drop'); if (from > -1 && from !== i) onMove(from, i); from = -1; });
  });
}
export function move(arr, from, to) {
  const [x] = arr.splice(from, 1);
  arr.splice(to, 0, x);
  return arr;
}

/** On narrow screens the editor sits above the list: bring it into view after a selection. */
export function revealOnMobile(el) {
  if (el && window.innerWidth <= 1200) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export const clone = (v) => JSON.parse(JSON.stringify(v));
export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
