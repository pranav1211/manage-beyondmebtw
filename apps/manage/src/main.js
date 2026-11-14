// Manage operational console (Vite + vanilla JS). Hash router; every value is
// escaped before rendering; nothing is invented — unknown stays "unknown",
// and an accepted operation is never shown as a success.

import { api, ApiError } from './api.js';

const view = document.getElementById('view');
const topbar = document.getElementById('topbar');
const TERMINAL = new Set(['succeeded', 'failed', 'blocked']);
const GLOBAL_CONFIRM = 'RECONCILE ALL ELIGIBLE APPS';
let pollTimer = null;

// ── helpers ───────────────────────────────────────────────────────────────
const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const badge = (state, label) => `<span class="badge s-${esc(String(state).toLowerCase())}">${esc(label ?? state)}</span>`;
const time = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
const json = (v) => `<pre class="json">${esc(JSON.stringify(v, null, 2))}</pre>`;
const setView = (html) => { view.innerHTML = html; };

function opState(op) {
  if (op.status === 'succeeded' && op.result && op.result.noop) return badge('noop', 'no-op');
  return badge(op.status);
}

function errorBanner(err) {
  const code = err instanceof ApiError ? err.code : 'ERROR';
  const msg = err instanceof ApiError ? err.message : 'Unexpected error';
  return `<div class="banner bad"><strong>${esc(code)}</strong> — ${esc(msg)}${
    err && err.details ? `<details><summary>details</summary>${json(err.details)}</details>` : ''
  }</div>`;
}

function persistenceNote(p) {
  if (!p) return '';
  if (p.pending) {
    return `<div class="banner warn">Saved and committed on the server, but <strong>not pushed to bmb-data yet</strong> (${esc(
      p.error && p.error.code
    )}). Use “Retry push”.</div>`;
  }
  return `<div class="banner info">${p.committed ? 'Committed' : 'No content change'}${p.pushed ? ' and pushed to bmb-data' : ''}${
    p.commit ? ` · <code>${esc(p.commit.slice(0, 12))}</code>` : ''
  }.</div>`;
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

async function guarded(fn) {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return showLogin();
    setView(errorBanner(err));
  }
}

// ── login ─────────────────────────────────────────────────────────────────
function showLogin(message) {
  stopPolling();
  topbar.classList.add('hidden');
  setView(`
    <section class="login card">
      <h1>Manage</h1>
      ${message ? `<div class="banner bad">${esc(message)}</div>` : ''}
      <form class="stack" id="login-form">
        <label>Admin password <input type="password" name="password" autocomplete="current-password" required autofocus /></label>
        <button class="btn primary" type="submit">Sign in</button>
      </form>
    </section>`);
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = new FormData(e.target).get('password');
    try {
      await api.login(String(pw));
      topbar.classList.remove('hidden');
      route();
    } catch (err) {
      showLogin(err.code === 'RATE_LIMITED' ? 'Too many attempts — wait and retry.' : 'Sign-in failed.');
    }
  });
}

// ── overview ──────────────────────────────────────────────────────────────
async function overview() {
  const [s, ops] = await Promise.all([api.status(), api.operations(undefined, 8).catch(() => null)]);
  const a = s.argus;
  setView(`
    <h1>Overview</h1>
    ${a.reachable ? '' : `<div class="banner bad"><strong>Argus unavailable</strong> (${esc(a.code)}). Operations cannot run until it is reachable.</div>`}
    ${s.registry.ok ? '' : `<div class="banner bad">Registry unreadable (${esc(s.registry.code)}).</div>`}
    <div class="grid">
      <div class="card"><h3>Manage</h3><dl class="kv"><dt>Status</dt><dd>${badge('ok')}</dd><dt>Env</dt><dd>${esc(s.manage.env)}</dd></dl></div>
      <div class="card"><h3>Argus</h3><dl class="kv">
        <dt>Reachable</dt><dd>${a.reachable ? badge('ok', 'yes') : badge('unavailable', 'no')}</dd>
        <dt>Mode</dt><dd>${a.reachable ? esc(a.mode) : badge('unknown')}</dd>
        <dt>Execution</dt><dd>${a.reachable ? (a.executionEnabled ? badge('ok', 'enabled') : badge('disabled')) : badge('unknown')}</dd>
      </dl></div>
      <div class="card"><h3>Registry</h3><dl class="kv">
        <dt>Applications</dt><dd>${s.registry.ok ? esc(s.registry.applications) : badge('unknown')}</dd>
        <dt>Enabled</dt><dd>${s.registry.ok ? esc(s.registry.enabled) : badge('unknown')}</dd>
      </dl></div>
    </div>
    <h2>Recent operations</h2>
    ${ops ? opsTable(ops.operations) : `<div class="banner warn">Operation history unavailable (Argus unreachable).</div>`}`);
}

// ── applications ──────────────────────────────────────────────────────────
function latestByApp(ops) {
  const m = new Map();
  for (const o of ops) if (!m.has(o.application)) m.set(o.application, o);
  return m;
}

async function apps() {
  const [reg, ops] = await Promise.all([api.registry(), api.operations(undefined, 100).catch(() => null)]);
  const latest = ops ? latestByApp(ops.operations) : null;
  const rows = reg.applications
    .map((e) => {
      const o = latest && latest.get(e.application);
      return `<tr class="clickable" data-href="#/apps/${encodeURIComponent(e.application)}">
        <td><strong>${esc(e.application)}</strong></td>
        <td>${esc(e.type)}</td><td><code>${esc(e.branch)}</code></td>
        <td>${e.enabled ? badge('enabled') : badge('disabled')}${e.environment === 'test' ? ' ' + badge('test') : ''}</td>
        <td>${latest ? (o ? `${esc(o.operation)} ${opState(o)}` : '<span class="muted">none</span>') : badge('unknown')}</td>
      </tr>`;
    })
    .join('');
  setView(`
    <h1>Applications</h1>
    <p class="sub">Registry source: <code>${esc(reg.source.repository)}</code> · <code>${esc(reg.source.path)}</code></p>
    ${reg.applications.length
      ? `<table><thead><tr><th>Application</th><th>Type</th><th>Branch</th><th>State</th><th>Latest operation</th></tr></thead><tbody>${rows}</tbody></table>`
      : `<div class="empty">No applications registered yet. Add one under <a href="#/registry">Registry</a>.</div>`}`);
}

const ACTIONS = [
  { op: 'deploy', label: 'Deploy (latest)', confirm: true },
  { op: 'build', label: 'Build', confirm: true },
  { op: 'sync', label: 'Sync only', confirm: false },
  { op: 'pm2.reconcile', label: 'Reconcile PM2', confirm: false, node: true },
  { op: 'pm2.restart', label: 'Restart', confirm: true, node: true },
  { op: 'pm2.stop', label: 'Stop', confirm: true, node: true, danger: true },
  { op: 'health', label: 'Health check', confirm: false }
];

async function appDetail(name) {
  const [{ entry, status }, ops] = await Promise.all([api.app(name), api.operations(name, 15).catch(() => null)]);
  const st = status || {};
  const decl = st.declaration;
  const declHtml = st.unavailable
    ? badge('unknown', 'unknown (Argus unavailable)')
    : decl == null
      ? badge('unknown', 'not checked (not deployed)')
      : decl.error
        ? badge('error', decl.error)
        : decl.match
          ? badge('match')
          : `${badge('mismatch')} <span class="muted">Registry stays authoritative.</span>${json(decl.mismatches)}`;
  const procs = st.unavailable || st.processes == null
    ? `<p>${badge('unknown')} <span class="muted">No runtime facts supplied.</span></p>`
    : st.processes.length === 0
      ? `<p>${badge('off', 'no process')}</p>`
      : `<table><thead><tr><th>Process</th><th>Status</th><th>PID</th><th>Restarts</th><th>Revision</th></tr></thead><tbody>${st.processes
          .map((p) => `<tr><td>${esc(p.name)}</td><td>${badge(p.status)}</td><td>${esc(p.pid ?? '—')}</td><td>${esc(p.restarts)}</td><td><code>${esc((p.revision || '—').slice(0, 12))}</code></td></tr>`)
          .join('')}</tbody></table>`;
  const exec = st.executable;
  const actions = ACTIONS.filter((a) => !a.node || entry.type === 'node')
    .map((a) => `<button class="btn ${a.danger ? 'danger' : ''}" data-op="${esc(a.op)}" data-confirm="${a.confirm}" ${entry.enabled ? '' : 'disabled'}>${esc(a.label)}</button>`)
    .join('');

  setView(`
    <h1>${esc(entry.application)}</h1>
    <p class="sub">${entry.enabled ? badge('enabled') : badge('disabled')} ${entry.environment === 'test' ? badge('test', 'test target') : ''}</p>
    ${st.unavailable ? `<div class="banner bad">Argus unavailable (${esc(st.code)}) — runtime state unknown.</div>` : ''}
    ${exec && !exec.ok ? `<div class="banner warn">Argus will refuse operations: <strong>${esc(exec.code)}</strong> — ${esc(exec.reason)}</div>` : ''}
    <div class="grid">
      <div class="card"><h3>Registry (authoritative)</h3><dl class="kv">
        <dt>Repository</dt><dd><code>${esc(entry.repository)}</code></dd>
        <dt>Branch</dt><dd><code>${esc(entry.branch)}</code></dd>
        <dt>Type</dt><dd>${esc(entry.type)}</dd>
        <dt>Path</dt><dd><code>${esc(entry.deploymentPath)}</code></dd>
        <dt>Domain</dt><dd>${esc(entry.domain)}${entry.isPrimaryDomain ? ' (primary)' : ''}</dd>
        <dt>PM2 config</dt><dd><code>${esc(entry.pm2Config ?? '—')}</code></dd>
        <dt>Nginx config</dt><dd><code>${esc(entry.nginxConfig ?? '—')}</code></dd>
      </dl></div>
      <div class="card"><h3>Repository declaration</h3>${declHtml}</div>
      <div class="card"><h3>Last deployed</h3>${st.deployed ? `<dl class="kv"><dt>Commit</dt><dd><code>${esc(st.deployed.commit.slice(0, 12))}</code></dd><dt>At</dt><dd>${time(st.deployed.at)}</dd><dt>Health</dt><dd>${st.deployed.healthy ? badge('ok', 'healthy') : badge('failed', 'unhealthy')}</dd></dl>` : badge('unknown', 'never deployed by Argus')}</div>
    </div>
    <h2>PM2 processes</h2>${entry.type === 'node' ? procs : '<p class="muted">Static application — no PM2 processes.</p>'}
    <h2>Actions</h2>
    <div class="actions">${actions}
      <button class="btn ghost" id="toggle-enabled">${entry.enabled ? 'Disable' : 'Enable'}</button>
      <a class="btn ghost" href="#/registry/${encodeURIComponent(entry.application)}/edit">Edit registry entry</a>
    </div>
    <div id="action-result"></div>
    <h2>Operations</h2>
    ${ops ? opsTable(ops.operations) : `<div class="banner warn">History unavailable (Argus unreachable).</div>`}`);

  view.querySelectorAll('[data-op]').forEach((b) =>
    b.addEventListener('click', async () => {
      const op = b.dataset.op;
      if (b.dataset.confirm === 'true' && !window.confirm(`Request "${op}" for ${entry.application}?`)) return;
      const out = document.getElementById('action-result');
      try {
        const r = await api.submit(op, entry.application);
        location.hash = `#/ops/${encodeURIComponent(r.operationId)}`;
      } catch (err) {
        out.innerHTML = errorBanner(err);
      }
    })
  );
  document.getElementById('toggle-enabled').addEventListener('click', async () => {
    if (!window.confirm(`${entry.enabled ? 'Disable' : 'Enable'} ${entry.application}? This commits to bmb-data.`)) return;
    const out = document.getElementById('action-result');
    try {
      const r = await api.setEnabled(entry.application, !entry.enabled);
      out.innerHTML = persistenceNote(r.persistence);
      setTimeout(() => guarded(() => appDetail(name)), 1200);
    } catch (err) {
      out.innerHTML = errorBanner(err);
    }
  });
}

// ── operations ────────────────────────────────────────────────────────────
function opsTable(list) {
  if (!list.length) return '<div class="empty">No operations recorded yet.</div>';
  return `<table><thead><tr><th>Operation</th><th>Application</th><th>Status</th><th>Stage</th><th>Created</th><th>Finished</th></tr></thead><tbody>${list
    .map(
      (o) => `<tr class="clickable" data-href="#/ops/${encodeURIComponent(o.operationId)}">
      <td><code>${esc(o.operation)}</code></td><td>${esc(o.application)}</td><td>${opState(o)}</td>
      <td>${esc(o.stage ?? '—')}</td><td>${time(o.createdAt)}</td><td>${time(o.finishedAt)}</td></tr>`
    )
    .join('')}</tbody></table>`;
}

async function opsList() {
  const r = await api.operations(undefined, 100);
  setView(`<h1>Operations</h1><p class="sub">${esc(r.total)} recorded. Accepted ≠ succeeded — open one to follow it.</p>${opsTable(r.operations)}`);
}

async function opDetail(id) {
  const render = (o) => `
    <h1>Operation <code>${esc(o.operationId)}</code></h1>
    <div class="grid"><div class="card"><dl class="kv">
      <dt>Operation</dt><dd><code>${esc(o.operation)}</code></dd>
      <dt>Application</dt><dd><a href="#/apps/${encodeURIComponent(o.application)}">${esc(o.application)}</a></dd>
      <dt>Status</dt><dd>${opState(o)}${TERMINAL.has(o.status) ? '' : ' <span class="muted">(live — refreshing)</span>'}</dd>
      <dt>Stage</dt><dd>${esc(o.stage ?? '—')}</dd>
      <dt>Created</dt><dd>${time(o.createdAt)}</dd>
      <dt>Finished</dt><dd>${time(o.finishedAt)}</dd>
    </dl></div></div>
    ${o.error ? `<h2>Failure</h2><div class="banner bad"><strong>${esc(o.error.code)}</strong> — ${esc(o.error.message)}</div>${o.error.details ? json(o.error.details) : ''}` : ''}
    <h2>Result</h2>${o.result ? json(o.result) : '<p class="muted">No result yet.</p>'}`;
  const first = await api.operation(id);
  setView(render(first));
  if (!TERMINAL.has(first.status)) {
    pollTimer = setInterval(() =>
      guarded(async () => {
        const o = await api.operation(id);
        setView(render(o));
        if (TERMINAL.has(o.status)) stopPolling();
      }), 1500);
  }
}

// ── reconcile ─────────────────────────────────────────────────────────────
async function reconcile() {
  const reg = await api.registry();
  const nodes = reg.applications.filter((e) => e.type === 'node');
  setView(`
    <h1>PM2 reconciliation</h1>
    <p class="sub">Reconcile makes an application's PM2 processes match its Argus-generated config. Unregistered processes are reported, never touched.</p>
    <div class="card"><h3>One application</h3>
      <form class="row" id="one">
        <select name="app" required>${nodes.map((e) => `<option value="${esc(e.application)}" ${e.enabled ? '' : 'disabled'}>${esc(e.application)}${e.enabled ? '' : ' (disabled)'}</option>`).join('')}</select>
        <button class="btn" type="submit" ${nodes.length ? '' : 'disabled'}>Reconcile</button>
      </form></div>
    <h2>All eligible applications</h2>
    <div class="card">
      <p class="muted">Eligible = enabled, node, not a test entry. Argus additionally refuses anything outside its production allowlist. Each application gets an independent result.</p>
      <form class="stack" id="all">
        <label>Type <code>${esc(GLOBAL_CONFIRM)}</code> to confirm<input name="confirm" autocomplete="off" /></label>
        <button class="btn danger" type="submit">Reconcile all eligible</button>
      </form>
    </div>
    <div id="rec-result"></div>`);
  document.getElementById('one').addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = document.getElementById('rec-result');
    try {
      const r = await api.reconcileApp(new FormData(e.target).get('app'));
      location.hash = `#/ops/${encodeURIComponent(r.operationId)}`;
    } catch (err) {
      out.innerHTML = errorBanner(err);
    }
  });
  document.getElementById('all').addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = document.getElementById('rec-result');
    const phrase = String(new FormData(e.target).get('confirm') || '');
    if (phrase !== GLOBAL_CONFIRM) {
      out.innerHTML = '<div class="banner warn">Confirmation phrase does not match.</div>';
      return;
    }
    try {
      const r = await api.reconcileAll(phrase);
      out.innerHTML = `<h2>Results</h2><table><thead><tr><th>Application</th><th>Result</th></tr></thead><tbody>${[
        ...r.results.map((x) => `<tr><td>${esc(x.application)}</td><td>${x.refused ? `${badge('refused')} <code>${esc(x.error.code)}</code> ${esc(x.error.message)}` : `${badge('accepted')} <a href="#/ops/${encodeURIComponent(x.operationId)}">${esc(x.operationId)}</a>`}</td></tr>`),
        ...r.skipped.map((x) => `<tr><td>${esc(x.application)}</td><td>${badge('skipped')} ${esc(x.reason)}</td></tr>`)
      ].join('')}</tbody></table>`;
    } catch (err) {
      out.innerHTML = errorBanner(err);
    }
  });
}

// ── registry ──────────────────────────────────────────────────────────────
const FIELDS = ['application', 'repository', 'branch', 'type', 'deploymentPath', 'domain', 'isPrimaryDomain', 'pm2Config', 'nginxConfig', 'enabled', 'environment', 'webhookSecretRef'];

function entryForm(e = {}, editing = false) {
  const v = (k) => esc(e[k] ?? '');
  return `<form class="stack" id="entry-form">
    <label>Application (repository name)<input name="application" value="${v('application')}" ${editing ? 'readonly' : 'required'} /></label>
    <label>Repository (SSH)<input name="repository" value="${v('repository')}" placeholder="git@github.com:owner/repo.git" required /></label>
    <label>Branch<input name="branch" value="${esc(e.branch ?? 'main')}" required /></label>
    <label>Type<select name="type"><option value="node" ${e.type === 'node' ? 'selected' : ''}>node</option><option value="static" ${e.type === 'static' ? 'selected' : ''}>static</option></select></label>
    <label>Deployment path<input name="deploymentPath" value="${v('deploymentPath')}" placeholder="/projects/&lt;application&gt;" required /></label>
    <label>Domain<input name="domain" value="${v('domain')}" required /></label>
    <label class="check"><input type="checkbox" name="isPrimaryDomain" ${e.isPrimaryDomain ? 'checked' : ''} /> Primary domain</label>
    <label>PM2 config file (node only)<input name="pm2Config" value="${v('pm2Config')}" placeholder="&lt;application&gt;.config.js" /></label>
    <label>Nginx config file (optional)<input name="nginxConfig" value="${v('nginxConfig')}" /></label>
    <label>Environment<select name="environment"><option value="production" ${e.environment !== 'test' ? 'selected' : ''}>production</option><option value="test" ${e.environment === 'test' ? 'selected' : ''}>test (never executed in production mode)</option></select></label>
    <label>Webhook secret ref (env var NAME, optional)<input name="webhookSecretRef" value="${v('webhookSecretRef')}" /></label>
    <label class="check"><input type="checkbox" name="enabled" ${e.enabled ? 'checked' : ''} /> Enabled</label>
    <div class="actions"><button class="btn primary" type="submit">${editing ? 'Save changes' : 'Register application'}</button></div>
  </form><div id="form-result"></div>`;
}

function readForm(form) {
  const fd = new FormData(form);
  const out = {};
  for (const k of FIELDS) {
    if (k === 'isPrimaryDomain' || k === 'enabled') { out[k] = fd.get(k) === 'on'; continue; }
    const raw = String(fd.get(k) ?? '').trim();
    if (k === 'pm2Config' || k === 'nginxConfig') { out[k] = raw === '' ? null : raw; continue; }
    if (k === 'webhookSecretRef') { if (raw) out[k] = raw; continue; }
    out[k] = raw;
  }
  return out;
}

async function registry(editName) {
  const reg = await api.registry();
  const editing = editName ? reg.applications.find((e) => e.application === editName) : null;
  setView(`
    <h1>Registry</h1>
    <p class="sub">Authoritative deployment configuration, stored in <code>${esc(reg.source.repository)}</code>. Every change is a scoped commit + push.</p>
    <div class="actions"><button class="btn ghost" id="retry">Retry push</button></div>
    <div id="retry-result"></div>
    <h2>${editing ? `Edit ${esc(editing.application)}` : 'Register an application'}</h2>
    ${entryForm(editing || {}, Boolean(editing))}
    <h2>Registered</h2>
    ${reg.applications.length
      ? `<table><thead><tr><th>Application</th><th>Type</th><th>State</th><th></th></tr></thead><tbody>${reg.applications
          .map((e) => `<tr><td>${esc(e.application)}</td><td>${esc(e.type)}</td><td>${e.enabled ? badge('enabled') : badge('disabled')}${e.environment === 'test' ? ' ' + badge('test') : ''}</td><td><a href="#/registry/${encodeURIComponent(e.application)}/edit">edit</a></td></tr>`)
          .join('')}</tbody></table>`
      : '<div class="empty">Nothing registered yet.</div>'}`);
  document.getElementById('entry-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = document.getElementById('form-result');
    const body = readForm(e.target);
    try {
      const r = editing ? await api.updateApp(editing.application, body) : await api.createApp(body);
      out.innerHTML = persistenceNote(r.persistence);
    } catch (err) {
      out.innerHTML = errorBanner(err);
    }
  });
  document.getElementById('retry').addEventListener('click', async () => {
    const out = document.getElementById('retry-result');
    try {
      out.innerHTML = persistenceNote((await api.retryPush()).persistence);
    } catch (err) {
      out.innerHTML = errorBanner(err);
    }
  });
}

// ── canonical data (bmb-data) ─────────────────────────────────────────────
const short = (sha) => (sha ? `<code>${esc(String(sha).slice(0, 12))}</code>` : '—');

async function dataPage(compareKey) {
  const [st, res, ops] = await Promise.all([api.dataStatus(), api.dataResources(), api.dataOperations(30)]);
  const r = st.repository;
  const cmp = compareKey ? await api.dataCompare(compareKey).catch((err) => ({ error: err })) : null;
  setView(`
    <h1>Canonical data</h1>
    ${r.blocked ? `<div class="banner bad"><strong>${esc(r.blocked)} blocked operation(s)</strong> — needs an explicit resolution.</div>` : ''}
    ${r.pendingPush ? `<div class="banner warn"><strong>${esc(r.pendingPush)} change(s) committed but not pushed</strong> to bmb-data yet.</div>` : ''}
    ${st.catalog.ok ? '' : `<div class="banner bad">Catalog invalid: ${esc(st.catalog.error && st.catalog.error.code)}</div>`}
    <section class="card"><h2>bmb-data checkout</h2><dl class="kv">
      <dt>Branch</dt><dd>${esc(r.branch)}</dd>
      <dt>Local HEAD</dt><dd>${short(r.head)}</dd>
      <dt>Remote (last fetched)</dt><dd>${short(r.remote)} ${r.head && r.head === r.remote ? badge('ok', 'in sync') : badge('unknown', 'differs')}</dd>
      <dt>Working tree</dt><dd>${r.dirty === null ? badge('unknown') : r.dirty ? badge('blocked', 'dirty') : badge('ok', 'clean')}</dd>
      <dt>Last webhook sync</dt><dd>${r.lastSync ? `${badge(r.lastSync.status)} ${esc(r.lastSync.result ? r.lastSync.result.state : '')} · ${time(r.lastSync.createdAt)}` : '—'}</dd>
      <dt>Catalog</dt><dd>${st.catalog.ok ? `${esc(st.catalog.resources)} resources · ${esc(st.catalog.imported)} imported` : '—'}</dd>
    </dl></section>
    <section class="card"><h2>Resources</h2>
      <table><thead><tr><th>Key</th><th>Access</th><th>Status</th><th>Path</th><th>Source</th><th></th></tr></thead><tbody>
      ${res.resources.map((x) => `<tr><td><code>${esc(x.key)}</code></td><td>${badge(x.access === 'private' ? 'blocked' : 'ok', x.access)}</td><td>${badge(x.status === 'imported' ? 'succeeded' : 'pending', x.status)}</td><td><code>${esc(x.path)}</code></td><td>${x.source ? `<code>${esc(x.source.repository)}:${esc(x.source.path)}</code>` : '—'}</td><td>${x.status === 'imported' ? `<a class="btn" href="#/data/res/${encodeURIComponent(x.key)}">Open</a> ` : ''}${x.source ? `<a class="btn" href="#/data/compare/${encodeURIComponent(x.key)}">Compare</a>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">No catalog yet.</td></tr>'}
      </tbody></table></section>
    ${cmp ? `<section class="card"><h2>Comparison: <code>${esc(compareKey)}</code></h2>${cmp.error ? errorBanner(cmp.error) : `<p>${cmp.identical ? badge('ok', 'identical') : badge('mismatch', 'differs')} · source ${esc(cmp.source.count ?? '—')} · target ${esc(cmp.target.present ? cmp.target.count : 'not imported')}</p>${json(cmp)}`}</section>` : ''}
    <section class="card"><h2>Data operations</h2><div id="data-retry"></div>
      <table><thead><tr><th>When</th><th>Action</th><th>Resources</th><th>Status</th><th>Phase</th><th>Commit</th><th></th></tr></thead><tbody>
      ${ops.operations.map((o) => `<tr><td>${time(o.createdAt)}</td><td>${esc(o.action)}</td><td>${esc((o.keys || []).join(', ') || (o.result && o.result.state) || '')}</td><td>${badge(o.status)}</td><td>${esc(o.phase || '—')}</td><td>${short(o.commit || (o.result && o.result.to))}</td><td>${['pending-push', 'failed', 'blocked'].includes(o.status) && o.kind === 'mutation' ? `<button class="btn" data-retry="${esc(o.operationId)}">Retry</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">No data operations yet.</td></tr>'}
      </tbody></table></section>`);
  view.querySelectorAll('button[data-retry]').forEach((b) =>
    b.addEventListener('click', async () => {
      const out = document.getElementById('data-retry');
      try {
        const op = await api.dataRetry(b.dataset.retry);
        out.innerHTML = `<div class="banner ${op.status === 'succeeded' ? 'info' : 'warn'}">${esc(op.operationId)}: ${esc(op.status)}</div>`;
        setTimeout(() => guarded(() => dataPage(compareKey)), 800);
      } catch (err) {
        out.innerHTML = errorBanner(err);
      }
    })
  );
}

async function dataResource(key) {
  const r = await api.dataResource(key);
  setView(`
    <p><a href="#/data">← Data</a></p>
    <h1><code>${esc(key)}</code></h1>
    <section class="card"><dl class="kv"><dt>Revision</dt><dd><code>${esc(r.revision.slice(0, 16))}</code></dd></dl>
      <form class="stack" id="res-form">
        <label>Document (JSON) <textarea name="doc" rows="22" spellcheck="false">${esc(JSON.stringify(r.data, null, 2))}</textarea></label>
        <button class="btn primary" type="submit">Save to bmb-data</button>
      </form>
      <div id="res-result"></div></section>`);
  document.getElementById('res-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = document.getElementById('res-result');
    let data;
    try {
      data = JSON.parse(new FormData(e.target).get('doc'));
    } catch {
      out.innerHTML = '<div class="banner bad">Not valid JSON — nothing was sent.</div>';
      return;
    }
    try {
      const res = await api.dataReplace(key, data, r.revision);
      const p = res.persistence;
      out.innerHTML = p.saved
        ? `<div class="banner info">${p.status === 'noop' ? 'No change.' : 'Saved, pushed and read back from bmb-data'} ${p.commit ? `· <code>${esc(p.commit.slice(0, 12))}</code>` : ''}</div>`
        : `<div class="banner warn">Committed locally but <strong>not pushed yet</strong> (${esc(p.error && p.error.code)}) — retry from the Data page.</div>`;
      if (p.saved) setTimeout(() => guarded(() => dataResource(key)), 1200);
    } catch (err) {
      out.innerHTML = errorBanner(err);
    }
  });
}

// ── router ────────────────────────────────────────────────────────────────
function route() {
  stopPolling();
  const h = location.hash.replace(/^#\/?/, '');
  const parts = h.split('/').map(decodeURIComponent);
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === (parts[0] || 'overview')));
  setView('<p class="muted">Loading…</p>');
  if (!parts[0]) return guarded(overview);
  if (parts[0] === 'apps') return guarded(() => (parts[1] ? appDetail(parts[1]) : apps()));
  if (parts[0] === 'ops') return guarded(() => (parts[1] ? opDetail(parts[1]) : opsList()));
  if (parts[0] === 'reconcile') return guarded(reconcile);
  if (parts[0] === 'registry') return guarded(() => registry(parts[2] === 'edit' ? parts[1] : null));
  if (parts[0] === 'data' && parts[1] === 'res' && parts[2]) return guarded(() => dataResource(parts[2]));
  if (parts[0] === 'data') return guarded(() => dataPage(parts[1] === 'compare' ? parts[2] : null));
  setView('<div class="empty">Not found.</div>');
}

view.addEventListener('click', (e) => {
  const row = e.target.closest('tr[data-href]');
  if (row && !e.target.closest('a,button')) location.hash = row.dataset.href;
});
document.getElementById('logout').addEventListener('click', async () => {
  try { await api.logout(); } finally { showLogin(); }
});
window.addEventListener('hashchange', route);

(async () => {
  try {
    const s = await api.session();
    if (!s.authenticated) return showLogin();
    topbar.classList.remove('hidden');
    route();
  } catch {
    showLogin('Manage API unreachable.');
  }
})();
