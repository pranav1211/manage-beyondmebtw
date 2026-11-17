// Apps & deploys: registry (bmb-data), Argus operations, PM2 reconcile, per-app env + Manage API token.
// Accepted ≠ succeeded: an operation is shown as running until Argus reports a terminal state.

import { api, ApiError } from '../api.js';
import { esc, badge, time, ago, json, icon, toast, errorText, busy, confirmDialog, modal, $, $$ } from '../ui.js';

const TERMINAL = new Set(['succeeded', 'failed', 'blocked']);
const GLOBAL_CONFIRM = 'RECONCILE ALL ELIGIBLE APPS';
const ACTIONS = [
  { op: 'deploy', label: 'Deploy latest', confirm: true, primary: true },
  { op: 'health', label: 'Health check' },
  { op: 'sync', label: 'Sync only' },
  { op: 'pm2.restart', label: 'Restart', confirm: true, node: true },
  { op: 'pm2.reconcile', label: 'Reconcile PM2', node: true },
  { op: 'build', label: 'Build', confirm: true },
  { op: 'pm2.stop', label: 'Stop', confirm: true, node: true, danger: true }
];
// The developer's top priority comes first everywhere apps are listed; the rest keep registry order.
const PRIORITY = ['beyondmebtw'];
export const byPriority = (list) => list.slice().sort((a, b) => {
  const pa = PRIORITY.indexOf(a.application), pb = PRIORITY.indexOf(b.application);
  return (pa === -1 ? PRIORITY.length : pa) - (pb === -1 ? PRIORITY.length : pb);
});
const hostLinks = (e) => [e.domain, ...(e.aliases || [])].map((h) => `<a href="https://${esc(h)}" target="_blank" rel="noopener">${esc(h)}</a>`).join('<br>');
const opState = (o) => (o.status === 'succeeded' && o.result && o.result.noop ? badge('noop', 'no-op') : badge(o.status));

function tabs(active) {
  return `<div class="tabs">${[['apps', 'Apps', '#/apps'], ['ops', 'Operations', '#/ops'], ['reconcile', 'Reconcile', '#/reconcile'], ['registry', 'Register an app', '#/registry']]
    .map(([id, label, href]) => `<a class="tab ${id === active ? 'on' : ''}" href="${href}">${label}</a>`).join('')}</div>`;
}
const header = (title, sub, active) => `<div class="head"><div><div class="kicker">Argus · deployments</div><h1>${title}</h1>${sub ? `<p class="sub">${sub}</p>` : ''}</div></div>${tabs(active)}`;

function persistenceText(p) {
  if (!p) return '';
  if (p.pending) return `Committed, but <b>not pushed to bmb-data yet</b>${p.error ? ` (${esc(p.error.code)})` : ''}. Use Retry push.`;
  return `${p.committed ? 'Committed' : 'No content change'}${p.pushed ? ' and pushed' : ''}${p.commit ? ` <code>${esc(String(p.commit).slice(0, 7))}</code>` : ''}`;
}

export async function render(view, parts, ctx) {
  const first = parts[0];
  if (first === 'ops') return parts[1] ? opDetail(view, parts[1]) : opsList(view);
  if (first === 'reconcile') return reconcile(view);
  if (first === 'registry') return registry(view, parts[2] === 'edit' ? parts[1] : null, ctx);
  if (parts[1]) return appDetail(view, parts[1], ctx);
  return appsList(view);
}

// ── list ──
async function appsList(view) {
  const [reg, ops] = await Promise.all([api.registry(), api.operations(undefined, 150).catch(() => null)]);
  const latest = new Map();
  if (ops) for (const o of ops.operations) if (!latest.has(o.application)) latest.set(o.application, o);
  view.innerHTML = `${header('Apps &amp; deploys', `${reg.applications.length} applications, registered in <code>${esc(reg.source.repository)}</code>. Pushes deploy automatically unless auto-deploy is off.`, 'apps')}
    ${ops ? '' : '<div class="banner bad">Argus is unreachable: runtime state and history are unknown.</div>'}
    <table><thead><tr><th>Application</th><th>Type</th><th>Domain</th><th>State</th><th>Last operation</th></tr></thead><tbody>
    ${byPriority(reg.applications).map((e) => { const o = latest.get(e.application); return `<tr class="click" data-href="#/apps/${encodeURIComponent(e.application)}">
      <td><b>${esc(e.application)}</b></td><td>${esc(e.type)}</td><td class="small">${hostLinks(e)}</td>
      <td>${e.enabled ? badge('enabled') : badge('disabled')} ${e.autoDeploy === false ? badge('pending', 'auto-deploy off') : ''}${e.environment === 'test' ? ` ${badge('test')}` : ''}</td>
      <td>${o ? `${esc(o.operation)} ${opState(o)} <span class="muted small">${esc(ago(o.createdAt))}</span>` : `<span class="muted">${ops ? 'none' : 'unknown'}</span>`}</td></tr>`; }).join('')}
    </tbody></table>`;
  $$('tr[data-href]', view).forEach((r) => r.addEventListener('click', (e) => { if (!e.target.closest('a')) location.hash = r.dataset.href; }));
}

// ── detail ──
async function appDetail(view, name, { reroute }) {
  const [{ entry, status }, ops] = await Promise.all([api.app(name), api.operations(name, 15).catch(() => null)]);
  const st = status || {};
  const decl = st.declaration;
  const declHtml = st.unavailable ? badge('unknown', 'unknown (Argus unavailable)')
    : decl == null ? badge('unknown', 'not checked (not deployed)')
      : decl.error ? badge('error', decl.error)
        : decl.match ? badge('match') : `${badge('mismatch')} <span class="muted">The registry stays authoritative.</span>${json(decl.mismatches)}`;
  const procs = st.unavailable || st.processes == null ? `<p>${badge('unknown')} <span class="muted">No runtime facts available.</span></p>`
    : st.processes.length === 0 ? `<p>${badge('off', 'no process')}</p>`
      : `<table><thead><tr><th>Process</th><th>Status</th><th>PID</th><th>Restarts</th><th>Revision</th></tr></thead><tbody>${st.processes.map((p) => `<tr><td>${esc(p.name)}</td><td>${badge(p.status)}</td><td>${esc(p.pid ?? '—')}</td><td>${esc(p.restarts)}</td><td><code>${esc((p.revision || '—').slice(0, 12))}</code></td></tr>`).join('')}</tbody></table>`;
  const exec = st.executable;
  view.innerHTML = `
    <div class="head"><div><div class="kicker"><a href="#/apps">Apps &amp; deploys</a></div><h1 class="mid">${esc(entry.application)}</h1>
      <p class="sub">${entry.enabled ? badge('enabled') : badge('disabled')} ${entry.autoDeploy === false ? badge('pending', 'auto-deploy off') : badge('ok', 'auto-deploy on')} ${entry.environment === 'test' ? badge('test', 'test target') : ''} · ${[entry.domain, ...(entry.aliases || [])].map((h) => `<a href="https://${esc(h)}" target="_blank" rel="noopener">${esc(h)}</a>`).join(' · ')}</p></div>
      <div class="acts"><a class="btn" href="#/registry/${encodeURIComponent(entry.application)}/edit">${icon('edit')}Edit registry entry</a></div></div>
    ${st.unavailable ? `<div class="banner bad">Argus is unavailable (${esc(st.code)}). Runtime state is unknown.</div>` : ''}
    ${st.undeployedPush ? `<div class="banner warn">Pushed but <b>not deployed</b> (auto-deploy is off): <code>${esc(st.undeployedPush.commit.slice(0, 12))}</code> · ${esc(time(st.undeployedPush.at))}. Deploy latest to ship it, or Restart to restart without deploying.</div>` : ''}
    ${exec && !exec.ok ? `<div class="banner warn">Argus will refuse operations: <b>${esc(exec.code)}</b>. ${esc(exec.reason)}</div>` : ''}
    <section class="card"><h2><span class="n">01</span>Actions</h2>
      <div class="row">${ACTIONS.filter((a) => !a.node || entry.type === 'node').map((a) => `<button class="btn ${a.primary ? 'primary' : ''} ${a.danger ? 'danger' : ''}" data-op="${esc(a.op)}" data-confirm="${a.confirm ? '1' : ''}" ${entry.enabled ? '' : 'disabled'}>${esc(a.label)}</button>`).join('')}</div>
      <div class="row" style="margin-top:14px">
        <label class="check" style="margin:0"><input type="checkbox" class="toggle" data-t="enabled" ${entry.enabled ? 'checked' : ''}>Enabled</label>
        <label class="check" style="margin:0 0 0 18px"><input type="checkbox" class="toggle" data-t="auto" ${entry.autoDeploy === false ? '' : 'checked'}>Auto-deploy on push</label>
      </div></section>
    <div class="grid cols-3 section">
      <div class="card"><h2>Registry</h2><dl class="kv"><dt>Repository</dt><dd><code>${esc(entry.repository)}</code></dd><dt>Branch</dt><dd><code>${esc(entry.branch)}</code></dd><dt>Type</dt><dd>${esc(entry.type)}</dd><dt>Path</dt><dd><code>${esc(entry.deploymentPath)}</code></dd><dt>PM2 config</dt><dd><code>${esc(entry.pm2Config ?? '—')}</code></dd><dt>Nginx</dt><dd><code>${esc(entry.nginxConfig ?? '—')}</code></dd></dl></div>
      <div class="card"><h2>Repository declaration</h2>${declHtml}</div>
      <div class="card"><h2>Last deployed</h2>${st.deployed ? `<dl class="kv"><dt>Commit</dt><dd><code>${esc(st.deployed.commit.slice(0, 12))}</code></dd><dt>At</dt><dd>${esc(time(st.deployed.at))}</dd><dt>Health</dt><dd>${st.deployed.healthy ? badge('ok', 'healthy') : badge('failed', 'unhealthy')}</dd></dl>` : badge('unknown', 'never deployed by Argus')}</div>
    </div>
    ${entry.type === 'node' ? `<section class="card section"><h2><span class="n">02</span>PM2 processes</h2>${procs}</section>` : ''}
    <section class="card section"><h2><span class="n">03</span>Environment<span class="aside mono">/infrastructure/env/${esc(entry.application)}.env</span></h2><div data-env><div class="loading"><span class="spin"></span>Loading…</div></div></section>
    <section class="card section"><h2><span class="n">04</span>Manage API token</h2><div data-tok><div class="loading"><span class="spin"></span>Loading…</div></div></section>
    <section class="section"><h2><span class="n">05</span>Recent operations<a class="aside" href="#/ops">All →</a></h2>${ops ? opsTable(ops.operations) : '<div class="banner warn">History unavailable (Argus unreachable).</div>'}</section>`;
  wireOpsTable(view);

  $$('[data-op]', view).forEach((b) => b.addEventListener('click', async () => {
    const op = b.dataset.op;
    if (b.dataset.confirm && !(await confirmDialog(`${b.textContent} ${entry.application}?`, `Argus runs <code>${esc(op)}</code> for ${esc(entry.application)}. You can follow it live.`, { confirmLabel: b.textContent, danger: op === 'pm2.stop' }))) return;
    await busy(b, 'Requesting', async () => {
      try { const r = await api.submit(op, entry.application); location.hash = `#/ops/${encodeURIComponent(r.operationId)}`; } catch (err) { toast(errorText(err), 'bad'); }
    });
  }));
  $$('[data-t]', view).forEach((t) => t.addEventListener('change', async () => {
    const on = t.checked;
    const enabled = t.dataset.t === 'enabled';
    const msg = enabled
      ? `${on ? 'Enable' : 'Disable'} ${esc(entry.application)}? ${on ? '' : 'Argus refuses every operation for a disabled app.'} This is a commit in bmb-data.`
      : on ? `Every push to <code>${esc(entry.branch)}</code> will deploy ${esc(entry.application)}${entry.type === 'node' ? ' and restart it' : ''}.` : 'Pushes will only be recorded; you deploy or restart by hand from here.';
    if (!(await confirmDialog(enabled ? (on ? 'Enable app' : 'Disable app') : `Turn auto-deploy ${on ? 'on' : 'off'}`, msg, { confirmLabel: 'Confirm' }))) { t.checked = !on; return; }
    try {
      const r = enabled ? await api.setEnabled(entry.application, on) : await api.setAutoDeploy(entry.application, on);
      toast(persistenceText(r.persistence), r.persistence && r.persistence.pending ? 'warn' : 'ok');
      reroute();
    } catch (err) { t.checked = !on; toast(errorText(err), 'bad'); }
  }));
  envAndToken(view, entry);
}

function restartNote(r) {
  if (!r) return '';
  if (r.refused) return ` Restart refused: ${esc(r.error && r.error.code)}.`;
  if (r.skipped) return ` (${esc(r.skipped)})`;
  return ` Restart requested: <a href="#/ops/${encodeURIComponent(r.operationId)}">follow it</a>.`;
}

function envAndToken(view, entry) {
  const envBox = $('[data-env]', view), tokBox = $('[data-tok]', view), app = entry.application;

  const drawEnv = async (note = '') => {
    let env;
    try { env = await api.appEnv(app); } catch (err) { envBox.innerHTML = `<div class="banner bad">${errorText(err)}</div>`; return; }
    envBox.innerHTML = `${note}<p class="muted small" style="margin-bottom:12px">Values are write-only: they are never shown again. The app loads this file at start.</p>
      <table><tbody>${env.keys.map((k) => `<tr><td><code>${esc(k.name)}</code> ${k.managedByManage ? badge('ok', 'written by Manage') : ''}</td><td style="text-align:right">${k.managedByManage ? '' : `<button class="btn sm ghost" data-unset="${esc(k.name)}">Remove</button>`}</td></tr>`).join('') || '<tr><td class="empty">No variables yet.</td></tr>'}</tbody></table>
      <form data-envf class="section"><div class="f2"><label class="f"><span>Name</span><input class="in mono" name="name" required pattern="[A-Z_][A-Z0-9_]*" placeholder="SITE_PASSWORD_HASH"></label>
        <label class="f"><span>Value</span><input class="in" name="value" type="password" autocomplete="off" required></label></div>
        <label class="check"><input type="checkbox" class="toggle" name="restart" checked>Restart the app afterwards</label>
        <button class="btn primary" type="submit">Set variable</button></form>`;
    $('[data-envf]', envBox).addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      await busy($('button[type=submit]', e.target), 'Saving', async () => {
        try { const r = await api.setAppEnv(app, { set: { [String(f.get('name'))]: String(f.get('value')) }, restart: f.get('restart') === 'on' }); drawEnv(`<div class="banner ok">Saved ${esc(f.get('name'))}.${restartNote(r.restart)}</div>`); } catch (err) { toast(errorText(err), 'bad'); }
      });
    });
    $$('[data-unset]', envBox).forEach((b) => b.addEventListener('click', async () => {
      if (!(await confirmDialog('Remove variable', `Remove <code>${esc(b.dataset.unset)}</code> from ${esc(app)}.env and restart the app?`, { confirmLabel: 'Remove', danger: true }))) return;
      try { const r = await api.setAppEnv(app, { unset: [b.dataset.unset], restart: true }); drawEnv(`<div class="banner ok">Removed ${esc(b.dataset.unset)}.${restartNote(r.restart)}</div>`); } catch (err) { toast(errorText(err), 'bad'); }
    }));
  };

  const drawToken = async (note = '') => {
    let t;
    try { t = await api.appToken(app); } catch (err) { tokBox.innerHTML = `<div class="banner bad">${errorText(err)}</div>`; return; }
    const c = t.client;
    const scopes = c ? c.scopes : t.suggestedScopes || [];
    tokBox.innerHTML = `${note}${c ? `<dl class="kv" style="margin-bottom:14px"><dt>Client</dt><dd><code>${esc(c.id)}</code> · issued ${esc(time(c.issuedAt))}</dd><dt>Endpoint</dt><dd><code>${esc(t.endpoints.base)}</code></dd>
        <dt>Resources</dt><dd>${[...t.endpoints.resources, ...t.endpoints.collections].map((r) => `<code>${esc(r.key)}</code> ${badge(r.access === 'read-write' ? 'ok' : 'unknown', r.access)}`).join('<br>') || '—'}</dd></dl>`
      : '<p class="muted" style="margin-bottom:12px">No token yet. Issuing one writes MANAGE_API_TOKEN and MANAGE_API_URL into this app’s env file.</p>'}
      <form data-tokf><label class="f"><span>Scopes <em>JSON: resource key or "prefix.*", access read or write</em></span><textarea class="in mono" name="scopes" rows="5" spellcheck="false">${esc(JSON.stringify(scopes, null, 2))}</textarea></label>
        <label class="check"><input type="checkbox" class="toggle" name="restart" checked>Restart the app afterwards</label>
        <div class="row"><button class="btn primary" type="submit">${c ? 'Rotate token' : 'Issue token'}</button>${c ? '<button class="btn danger" type="button" data-revoke>Revoke</button>' : ''}</div></form>`;
    $('[data-tokf]', tokBox).addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      let parsed;
      try { parsed = JSON.parse(String(f.get('scopes'))); } catch { toast('Scopes are not valid JSON', 'bad'); return; }
      if (c && !(await confirmDialog('Rotate token', 'The current token stops working immediately; the new one is written to the app’s env file.', { confirmLabel: 'Rotate' }))) return;
      try {
        const r = await api.issueAppToken(app, { scopes: parsed, restart: f.get('restart') === 'on' });
        drawToken(`<div class="banner ok">Token written to <code>${esc(r.writtenTo)}</code>.${restartNote(r.restart)}<details style="margin-top:6px"><summary>Show the token once (only for use outside this server)</summary><code>${esc(r.token)}</code></details></div>`);
        drawEnv();
      } catch (err) { toast(errorText(err), 'bad'); }
    });
    const rv = $('[data-revoke]', tokBox);
    if (rv) rv.addEventListener('click', async () => {
      if (!(await confirmDialog('Revoke token', `${esc(app)} loses access to its Manage data.`, { confirmLabel: 'Revoke', danger: true }))) return;
      try { const r = await api.revokeAppToken(app); drawToken(`<div class="banner warn">Token revoked.${restartNote(r.restart)}</div>`); drawEnv(); } catch (err) { toast(errorText(err), 'bad'); }
    });
  };
  drawEnv();
  drawToken();
}

// ── operations ──
function opsTable(list) {
  if (!list.length) return '<div class="empty">No operations recorded yet.</div>';
  return `<table><thead><tr><th>Operation</th><th>Application</th><th>Status</th><th>Stage</th><th>Started</th><th>Finished</th></tr></thead><tbody>${list.map((o) => `<tr class="click" data-href="#/ops/${encodeURIComponent(o.operationId)}">
    <td><code>${esc(o.operation)}</code></td><td>${esc(o.application)}</td><td>${opState(o)}</td><td>${esc(o.stage ?? '—')}</td><td title="${esc(time(o.createdAt))}">${esc(ago(o.createdAt))}</td><td>${o.finishedAt ? esc(ago(o.finishedAt)) : '—'}</td></tr>`).join('')}</tbody></table>`;
}
const wireOpsTable = (view) => $$('tr[data-href]', view).forEach((r) => r.addEventListener('click', () => { location.hash = r.dataset.href; }));

async function opsList(view) {
  let r;
  try { r = await api.operations(undefined, 100); } catch (err) {
    view.innerHTML = `${header('Operations', '', 'ops')}<div class="banner bad">${errorText(err)}. Operation history lives in Argus; it shows here again once Argus is reachable.</div>`;
    return;
  }
  view.innerHTML = `${header('Operations', `${esc(r.total)} recorded. Accepted is not succeeded: open one to follow it.`, 'ops')}${opsTable(r.operations)}`;
  wireOpsTable(view);
}

async function opDetail(view, id) {
  let timer = null;
  const draw = (o) => {
    view.innerHTML = `
      <div class="head"><div><div class="kicker"><a href="#/ops">Operations</a></div><h1 class="mid">${esc(o.operation)} · ${esc(o.application)}</h1>
        <p class="sub">${opState(o)} ${TERMINAL.has(o.status) ? '' : '<span class="spin"></span>live'} · <code>${esc(o.operationId)}</code></p></div>
        <div class="acts"><a class="btn" href="#/apps/${encodeURIComponent(o.application)}">Open app</a></div></div>
      <section class="card"><dl class="kv"><dt>Stage</dt><dd>${esc(o.stage ?? '—')}</dd><dt>Started</dt><dd>${esc(time(o.createdAt))}</dd><dt>Finished</dt><dd>${esc(time(o.finishedAt))}</dd></dl></section>
      ${o.error ? `<section class="section"><h2>Failure</h2><div class="banner bad"><b>${esc(o.error.code)}</b> ${esc(o.error.message)}</div>${o.error.details ? json(o.error.details) : ''}</section>` : ''}
      <section class="section"><h2>Result</h2>${o.result ? json(o.result) : '<p class="muted">No result yet.</p>'}</section>`;
  };
  const o = await api.operation(id);
  draw(o);
  if (!TERMINAL.has(o.status)) {
    timer = setInterval(async () => {
      try { const n = await api.operation(id); draw(n); if (TERMINAL.has(n.status)) { clearInterval(timer); timer = null; toast(`${n.operation} ${n.status}`, n.status === 'succeeded' ? 'ok' : 'bad'); } } catch (err) { if (err instanceof ApiError && err.status === 401) location.reload(); }
    }, 1500);
  }
  return () => { if (timer) clearInterval(timer); };
}

// ── reconcile ──
async function reconcile(view) {
  const reg = await api.registry();
  const nodes = reg.applications.filter((e) => e.type === 'node');
  view.innerHTML = `${header('Reconcile', 'Make an app’s PM2 processes match its Argus-generated config. Processes Argus does not manage are reported, never touched.', 'reconcile')}
    <div class="grid cols-2">
      <section class="card"><h2>One application</h2><form data-one class="row"><select class="in" name="app" style="max-width:280px">${nodes.map((e) => `<option value="${esc(e.application)}" ${e.enabled ? '' : 'disabled'}>${esc(e.application)}${e.enabled ? '' : ' (disabled)'}</option>`).join('')}</select><button class="btn primary" type="submit" ${nodes.length ? '' : 'disabled'}>Reconcile</button></form></section>
      <section class="card"><h2>Every eligible application</h2><p class="muted small" style="margin-bottom:12px">Eligible: enabled, node, not a test entry, and on Argus's allowlist. Each app gets its own result.</p>
        <button class="btn danger" data-all>Reconcile all…</button></section>
    </div><div data-out class="section"></div>`;
  $('[data-one]', view).addEventListener('submit', async (e) => {
    e.preventDefault();
    try { const r = await api.reconcileApp(new FormData(e.target).get('app')); location.hash = `#/ops/${encodeURIComponent(r.operationId)}`; } catch (err) { toast(errorText(err), 'bad'); }
  });
  $('[data-all]', view).addEventListener('click', async () => {
    const ok = await modal({ title: 'Reconcile every eligible app', typed: GLOBAL_CONFIRM, body: '<p class="lead">Argus reconciles each eligible node app independently.</p>', actions: [{ label: 'Cancel', value: false }, { label: 'Reconcile all', value: true, kind: 'danger' }] });
    if (!ok) return;
    try {
      const r = await api.reconcileAll(GLOBAL_CONFIRM);
      $('[data-out]', view).innerHTML = `<h2>Results</h2><table><tbody>${[
        ...r.results.map((x) => `<tr><td>${esc(x.application)}</td><td>${x.refused ? `${badge('refused')} <code>${esc(x.error.code)}</code> ${esc(x.error.message)}` : `${badge('accepted')} <a href="#/ops/${encodeURIComponent(x.operationId)}">follow</a>`}</td></tr>`),
        ...r.skipped.map((x) => `<tr><td>${esc(x.application)}</td><td>${badge('skipped')} ${esc(x.reason)}</td></tr>`)
      ].join('')}</tbody></table>`;
    } catch (err) { toast(errorText(err), 'bad'); }
  });
}

// ── registry ──
const FIELDS = ['application', 'repository', 'branch', 'type', 'deploymentPath', 'domain', 'isPrimaryDomain', 'pm2Config', 'nginxConfig', 'enabled', 'environment', 'webhookSecretRef', 'aliases'];
/**
 * The registry PUT replaces the whole entry, so fields this form doesn't show (autoDeploy, …)
 * are carried over from the existing entry instead of being silently dropped.
 */
function readForm(form, existing) {
  const fd = new FormData(form);
  const out = {};
  if (existing) for (const [k, v] of Object.entries(existing)) if (!FIELDS.includes(k)) out[k] = v;
  for (const k of FIELDS) {
    if (k === 'isPrimaryDomain' || k === 'enabled') { out[k] = fd.get(k) === 'on'; continue; }
    const raw = String(fd.get(k) ?? '').trim();
    if (k === 'pm2Config' || k === 'nginxConfig') { out[k] = raw === '' ? null : raw; continue; }
    if (k === 'webhookSecretRef') { if (raw) out[k] = raw; continue; }
    if (k === 'aliases') { const list = [...new Set(raw.split(/[\s,]+/).map((h) => h.trim().toLowerCase()).filter(Boolean))]; if (list.length) out[k] = list; continue; }
    out[k] = raw;
  }
  return out;
}

async function registry(view, editName) {
  const reg = await api.registry();
  const e = editName ? reg.applications.find((x) => x.application === editName) : null;
  if (editName && !e) { view.innerHTML = `<div class="banner bad">No registered app called ${esc(editName)}.</div>`; return; }
  const v = (k) => esc((e && e[k]) ?? '');
  view.innerHTML = `${e ? `<div class="head"><div><div class="kicker"><a href="#/apps/${encodeURIComponent(e.application)}">${esc(e.application)}</a></div><h1 class="mid">Edit registry entry</h1><p class="sub">The registry is authoritative. Each change is a commit and push to bmb-data.</p></div></div>`
    : header('Register an app', 'Add an application for Argus to deploy. It also needs an <code>argus.deploy.json</code> in its repository and a place on Argus\'s allowlist.', 'registry')}
    <section class="card" style="max-width:820px"><form data-f>
      <div class="f2"><label class="f"><span>Application (repository name)</span><input class="in" name="application" value="${v('application')}" ${e ? 'readonly' : 'required'}></label>
        <label class="f"><span>Type</span><select class="in" name="type"><option value="static" ${e && e.type === 'static' ? 'selected' : ''}>static</option><option value="node" ${e && e.type === 'node' ? 'selected' : ''}>node</option></select></label></div>
      <div class="f2"><label class="f"><span>Repository (SSH)</span><input class="in mono" name="repository" value="${v('repository')}" placeholder="git@github.com:owner/repo.git" required></label>
        <label class="f"><span>Branch</span><input class="in" name="branch" value="${esc((e && e.branch) || 'main')}" required></label></div>
      <div class="f2"><label class="f"><span>Deployment path</span><input class="in mono" name="deploymentPath" value="${v('deploymentPath')}" placeholder="/projects/&lt;application&gt;" required></label>
        <label class="f"><span>Domain</span><input class="in" name="domain" value="${v('domain')}" required></label></div>
      <div class="f2"><label class="f"><span>PM2 config file (node only)</span><input class="in mono" name="pm2Config" value="${v('pm2Config')}" placeholder="&lt;application&gt;.config.js"></label>
        <label class="f"><span>Nginx config file (optional)</span><input class="in mono" name="nginxConfig" value="${v('nginxConfig')}"></label></div>
      <div class="f2"><label class="f"><span>Environment</span><select class="in" name="environment"><option value="production" ${!e || e.environment !== 'test' ? 'selected' : ''}>production</option><option value="test" ${e && e.environment === 'test' ? 'selected' : ''}>test (never executed in production)</option></select></label>
        <label class="f"><span>Webhook secret env var (optional)</span><input class="in mono" name="webhookSecretRef" value="${v('webhookSecretRef')}" placeholder="default secret if empty"></label></div>
      <label class="f"><span>Other hostnames <em>comma separated; shown here, routed by nginx</em></span><input class="in mono" name="aliases" value="${esc(((e && e.aliases) || []).join(', '))}" placeholder="blog.beyondmebtw.com, www.example.com"></label>
      <label class="check"><input type="checkbox" class="toggle" name="isPrimaryDomain" ${e && e.isPrimaryDomain ? 'checked' : ''}>Primary domain</label>
      <label class="check"><input type="checkbox" class="toggle" name="enabled" ${!e || e.enabled ? 'checked' : ''}>Enabled</label>
      <div class="formbar"><button class="btn primary" type="submit">${e ? 'Save entry' : 'Register application'}</button><button class="btn ghost" type="button" data-retry>Retry push</button></div>
    </form></section>`;
  $('[data-f]', view).addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const body = readForm(ev.target, e);
    await busy($('button[type=submit]', ev.target), 'Saving', async () => {
      try {
        const r = e ? await api.updateApp(e.application, body) : await api.createApp(body);
        toast(persistenceText(r.persistence), r.persistence && r.persistence.pending ? 'warn' : 'ok');
        location.hash = `#/apps/${encodeURIComponent(body.application)}`;
      } catch (err) { toast(errorText(err), 'bad'); }
    });
  });
  $('[data-retry]', view).addEventListener('click', async (ev) => {
    await busy(ev.currentTarget, 'Retrying', async () => { try { const r = await api.retryPush(); toast(persistenceText(r.persistence)); } catch (err) { toast(errorText(err), 'bad'); } });
  });
}
