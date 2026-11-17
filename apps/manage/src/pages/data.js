// Data (advanced): the bmb-data checkout, every catalog resource, data-operation history with retry,
// and a raw JSON editor for anything the purpose-built editors don't cover.

import { api } from '../api.js';
import { esc, badge, ago, time, short, toast, toastSaved, saveFailed, errorText, busy, setDirtyCheck, confirmDialog, $, $$ } from '../ui.js';

export async function render(view, parts, ctx) {
  if (parts[1]) return rawEditor(view, parts[1], ctx);
  const [st, res, ops] = await Promise.all([api.dataStatus(), api.dataResources(), api.dataOperations(40)]);
  const r = st.repository;
  const editors = { 'home.latest': '#/home', 'blog.categories': '#/categories', projects: '#/projects', photos: '#/photos', 'minis.metadata': '#/minis' };
  const editorFor = (k) => editors[k] || (k.startsWith('blog.posts.') ? `#/blog/${encodeURIComponent(k.slice(11))}` : null);
  view.innerHTML = `
    <div class="head"><div><div class="kicker">bmb-data</div><h1>Data</h1><p class="sub">The canonical store behind every page. Use the editors for day-to-day work; this page shows the repository, every resource, and the history of changes.</p></div></div>
    ${r.blocked ? `<div class="banner bad"><b>${esc(r.blocked)} blocked operation(s)</b> need a decision below.</div>` : ''}
    ${r.pendingPush ? `<div class="banner warn"><b>${esc(r.pendingPush)} change(s) committed but not pushed</b> to GitHub yet. Retry them below.</div>` : ''}
    ${st.catalog.ok ? '' : `<div class="banner bad">Catalog invalid: ${esc(st.catalog.error && st.catalog.error.code)}</div>`}
    <div class="grid cols-3">
      <div class="card"><h2>Checkout</h2><dl class="kv"><dt>Branch</dt><dd>${esc(r.branch)}</dd><dt>Local</dt><dd><code>${esc(short(r.head))}</code></dd><dt>Remote</dt><dd><code>${esc(short(r.remote))}</code> ${r.head && r.head === r.remote ? badge('ok', 'in sync') : badge('unknown', 'differs')}</dd></dl></div>
      <div class="card"><h2>Working tree</h2><div class="big" style="font-size:44px">${r.dirty === null ? '?' : r.dirty ? 'Dirty' : 'Clean'}</div><p class="muted small" style="margin-top:6px">${r.lastSync ? `Last webhook sync ${esc(ago(r.lastSync.createdAt))}: ${esc(r.lastSync.result ? r.lastSync.result.state : r.lastSync.status)}` : 'No webhook sync yet.'}</p></div>
      <div class="card"><h2>Catalog</h2><div class="big" style="font-size:44px">${st.catalog.ok ? esc(st.catalog.resources) : '—'}</div><p class="muted small" style="margin-top:6px">resources · ${st.catalog.ok ? esc(st.catalog.imported) : '—'} with data</p></div>
    </div>
    <section class="section"><h2><span class="n">01</span>Resources</h2>
      <table><thead><tr><th>Key</th><th>Access</th><th>Path</th><th></th></tr></thead><tbody>
      ${res.resources.filter((x) => x.status !== 'collection').map((x) => `<tr><td><code>${esc(x.key)}</code></td><td>${badge(x.access === 'private' ? 'blocked' : 'ok', x.access)}</td><td><code class="muted">${esc(x.path || '')}</code></td>
        <td style="text-align:right;white-space:nowrap">${editorFor(x.key) ? `<a class="btn sm" href="${editorFor(x.key)}">Editor</a> ` : ''}${x.status === 'imported' ? `<a class="btn sm ghost" href="#/data/${encodeURIComponent(x.key)}">JSON</a>` : badge('unknown', x.status)}</td></tr>`).join('')}
      </tbody></table></section>
    <section class="section"><h2><span class="n">02</span>Changes<span class="aside">newest first</span></h2>
      <table><thead><tr><th>When</th><th>Change</th><th>Resources</th><th>Status</th><th>Commit</th><th></th></tr></thead><tbody>
      ${ops.operations.map((o) => `<tr><td title="${esc(time(o.createdAt))}">${esc(ago(o.createdAt))}</td><td>${esc(o.action)}</td><td class="small">${esc((o.keys || []).join(', ') || (o.result && o.result.state) || '')}</td><td>${badge(o.status)}</td><td><code>${esc(short(o.commit || (o.result && o.result.to)))}</code></td>
        <td>${['pending-push', 'failed', 'blocked'].includes(o.status) && o.kind === 'mutation' ? `<button class="btn sm" data-retry="${esc(o.operationId)}">Retry</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">No data operations yet.</td></tr>'}
      </tbody></table></section>`;
  $$('[data-retry]', view).forEach((b) => b.addEventListener('click', async () => {
    await busy(b, 'Retrying', async () => {
      try { const op = await api.dataRetry(b.dataset.retry); toast(`${esc(op.operationId)}: ${esc(op.status)}`, op.status === 'succeeded' ? 'ok' : 'warn'); ctx.reroute(); } catch (err) { toast(errorText(err), 'bad'); }
    });
  }));
}

async function rawEditor(view, key, { reroute }) {
  const r = await api.read(key);
  const text = JSON.stringify(r.data, null, 2);
  view.innerHTML = `
    <div class="head"><div><div class="kicker"><a href="#/data">Data</a> · raw JSON</div><h1 class="mid">${esc(key)}</h1><p class="sub">Edits the whole document. The server validates it against the resource schema before anything is committed; the purpose-built editors are safer for everyday changes.</p></div></div>
    <section class="card"><textarea class="in mono" data-doc rows="28" spellcheck="false">${esc(text)}</textarea>
      <div class="formbar"><button class="btn primary" data-save>Save to bmb-data</button><button class="btn ghost" data-reset>Reset</button><span class="muted small mono">revision ${esc(r.revision.slice(0, 12))}</span></div></section>`;
  const ta = $('[data-doc]', view);
  setDirtyCheck(() => ta.value !== text);
  $('[data-reset]', view).addEventListener('click', () => { ta.value = text; });
  $('[data-save]', view).addEventListener('click', async (e) => {
    let data;
    try { data = JSON.parse(ta.value); } catch (err) { toast(`Not valid JSON: ${esc(err.message)}`, 'bad'); return; }
    if (!(await confirmDialog('Save raw document', `Replace <code>${esc(key)}</code> with this JSON? It is one commit in bmb-data.`, { confirmLabel: 'Save' }))) return;
    await busy(e.currentTarget, 'Saving', async () => {
      try { toastSaved(await api.replace(key, data, r.revision)); setDirtyCheck(null); reroute(); } catch (err) { saveFailed(err, () => { setDirtyCheck(null); reroute(); }); }
    });
  });
}
