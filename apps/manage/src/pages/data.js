// Data: every dataset in bmb-data, grouped (pills), with its endpoints and how apps get access;
// adding datasets (documents or collections) and collection members; change history with retry;
// and a raw JSON editor for anything the purpose-built editors don't cover.

import { api } from '../api.js';
import { esc, badge, ago, time, short, icon, toast, toastSaved, saveFailed, errorText, busy, setDirtyCheck, confirmDialog, modal, $, $$ } from '../ui.js';

const EDITORS = { 'home.latest': '#/home', 'blog.categories': '#/categories', projects: '#/projects', photos: '#/photos', 'minis.metadata': '#/minis' };
const editorFor = (k) => EDITORS[k] || (/^blog\.posts\.[a-z0-9]+$/.test(k) ? `#/blog/${encodeURIComponent(k.slice(11))}` : null);
const groupOf = (r) => (r.collection || r.key).split('.')[0];

export async function render(view, parts, ctx) {
  if (parts[1] && !parts[1].startsWith('@')) return rawEditor(view, parts[1], ctx);
  const [st, res, reg] = await Promise.all([api.dataStatus(), api.dataResources(), api.registry().catch(() => ({ applications: [] }))]);
  const all = res.resources;
  const groups = [...new Set(all.map(groupOf))];
  const apps = reg.applications.map((a) => a.application);
  const S = { group: parts[1] ? parts[1].slice(1) : groups[0], sel: parts[2] || null, opsLimit: 25 };
  if (S.group !== 'changes' && !groups.includes(S.group)) S.group = groups[0];
  const setHash = () => history.replaceState(null, '', `#/data/@${encodeURIComponent(S.group)}${S.sel ? `/${encodeURIComponent(S.sel)}` : ''}`);
  const r = st.repository;

  function draw() {
    view.innerHTML = `
      <div class="head"><div><div class="kicker">bmb-data</div><h1>Data</h1><p class="sub">Every dataset behind the sites and apps. Pick a group, select a dataset to see its endpoints and how an app gets access, or add a new one.</p></div>
        <div class="acts"><button class="btn primary" data-a="new">${icon('plus')}New dataset</button></div></div>
      ${r.blocked ? `<div class="banner bad"><b>${esc(r.blocked)} blocked change(s)</b> need a decision: see Changes.</div>` : ''}
      ${r.pendingPush ? `<div class="banner warn"><b>${esc(r.pendingPush)} change(s) committed but not pushed</b> to GitHub yet: retry them under Changes.</div>` : ''}
      ${st.catalog.ok ? '' : `<div class="banner bad">Catalog invalid: ${esc(st.catalog.error && st.catalog.error.code)}</div>`}
      <div class="row small muted" style="margin-bottom:16px;gap:14px">
        <span>Branch <b>${esc(r.branch)}</b></span><span>Local <code>${esc(short(r.head))}</code></span>
        <span>Remote <code>${esc(short(r.remote))}</code> ${r.head && r.head === r.remote ? badge('ok', 'in sync') : badge('unknown', 'differs')}</span>
        <span>Working tree ${r.dirty === null ? badge('unknown') : r.dirty ? badge('blocked', 'dirty') : badge('ok', 'clean')}</span>
        <span>${r.lastSync ? `Last webhook sync ${esc(ago(r.lastSync.createdAt))}` : ''}</span>
      </div>
      <div class="tabs">${groups.map((g) => `<button class="tab ${g === S.group ? 'on' : ''}" data-g="${esc(g)}">${esc(g)}<small>${all.filter((x) => groupOf(x) === g && x.status !== 'collection').length}</small></button>`).join('')}
        <button class="tab ${S.group === 'changes' ? 'on' : ''}" data-g="changes">Changes</button></div>
      <div data-body></div>`;
    $$('[data-g]', view).forEach((b) => b.addEventListener('click', () => { S.group = b.dataset.g; S.sel = null; setHash(); draw(); }));
    $('[data-a="new"]', view).addEventListener('click', () => newDataset());
    if (S.group === 'changes') drawChanges(); else drawGroup();
  }

  function drawGroup() {
    const items = all.filter((x) => groupOf(x) === S.group);
    const top = items.filter((x) => !x.collection);
    if (!S.sel || !items.some((x) => x.key === S.sel)) S.sel = top[0] ? top[0].key : null;
    const row = (x, indent = false) => `<div class="li ${x.key === S.sel ? 'sel' : ''}" data-k="${esc(x.key)}" ${indent ? 'style="padding-left:34px"' : ''}>
      <div class="tx"><b class="mono" style="font-size:13px">${esc(x.key)}</b><span>${esc(x.status === 'collection' ? 'collection' : x.title || x.path || '')}</span></div>
      ${x.status === 'collection' ? `<span class="pill blue">${items.filter((m) => m.collection === x.key).length} members</span>` : ''}${x.access === 'private' ? '<span class="pill pink">private</span>' : ''}</div>`;
    $('[data-body]', view).innerHTML = `<div class="split">
      <div class="list">${top.map((x) => row(x) + items.filter((m) => m.collection === x.key).map((m) => row(m, true)).join('')).join('') || '<div class="empty">Nothing in this group.</div>'}</div>
      <aside class="card sticky" data-detail></aside></div>`;
    $$('[data-k]', view).forEach((el) => el.addEventListener('click', () => { S.sel = el.dataset.k; setHash(); drawGroup(); }));
    drawDetail();
  }

  function endpointRows(x) {
    const base = `${location.origin}/api/v1/data/resources/`;
    const isColl = x.status === 'collection';
    const k = isColl ? `${x.key}.<id>` : x.key;
    const ops = x.operations || [];
    const rows = [];
    if (ops.includes('read')) rows.push(['GET', base + k, x.access === 'public' ? 'anyone' : 'token (read) or admin']);
    if (ops.includes('replace') || (isColl && ops.includes('create'))) rows.push(['PUT', base + k, `{"data": …, "ifRevision": "…"}${isColl ? ' · creates the member if new' : ''}`]);
    if ((isColl || x.collection) && ops.includes('delete')) rows.push(['DELETE', base + k, 'removes the member']);
    if (x.items) {
      rows.push(['POST', `${base + k}/items`, `{"item": {…"${x.items.idField}": …}}`]);
      rows.push(['PUT', `${base + k}/items/<${x.items.idField}>`, '{"item": …}']);
      rows.push(['DELETE', `${base + k}/items/<${x.items.idField}>`, '']);
    }
    return rows;
  }

  function drawDetail() {
    const box = $('[data-detail]', view);
    const x = all.find((y) => y.key === S.sel);
    if (!x) { box.innerHTML = '<div class="empty">Select a dataset.</div>'; return; }
    const isColl = x.status === 'collection';
    const parent = x.collection ? all.find((y) => y.key === x.collection) : null;
    const scopeKey = isColl ? `${x.key}.*` : x.key;
    const owner = (parent || x).owner;
    const ed = editorFor(x.key);
    box.innerHTML = `
      <div class="kicker">${isColl ? 'Collection · one file per member' : x.collection ? `Member of ${esc(x.collection)}` : 'Document · one file'}</div>
      <h3 style="margin:6px 0 14px;overflow-wrap:anywhere">${esc(x.title || x.key)}</h3>
      <dl class="kv" style="margin-bottom:16px"><dt>Key</dt><dd><code>${esc(x.key)}</code></dd><dt>File</dt><dd><code>${esc(x.path || '')}</code></dd>
        <dt>Access</dt><dd>${x.access === 'public' ? badge('ok', 'public read') : badge('blocked', 'private')}</dd>
        <dt>Owner</dt><dd>${owner && apps.includes(owner) ? `<a href="#/apps/${encodeURIComponent(owner)}">${esc(owner)}</a>` : esc(owner || '—')}</dd>
        ${x.items ? `<dt>Items</dt><dd>a list, each item identified by <code>${esc(x.items.idField)}</code></dd>` : ''}</dl>
      <div class="row" style="margin-bottom:18px">
        ${ed ? `<a class="btn sm primary" href="${ed}">Open editor</a>` : ''}
        ${!isColl ? `<a class="btn sm" href="#/data/${encodeURIComponent(x.key)}">Edit JSON</a>` : `<button class="btn sm primary" data-a="member">${icon('plus')}New member</button>`}
      </div>
      <h2>Endpoints</h2>
      <div class="eps">${endpointRows(x).map(([m, url, note]) => `<div class="ep"><span class="m m-${m.toLowerCase()}">${m}</span><code>${esc(url)}</code><button class="iconbtn" title="Copy" data-copy="${esc(url)}">${icon('copy')}</button>${note ? `<div class="note">${esc(note)}</div>` : ''}</div>`).join('')}</div>
      <h2 style="margin-top:18px">Give an app access</h2>
      <p class="small muted" style="margin-bottom:8px">Apps send their <code>MANAGE_API_TOKEN</code> as a bearer token in the <code>Authorization</code> header. On the app's page under <b>Manage API token</b>, include this scope (use <code>"read"</code> for read-only):</p>
      <div class="ep"><code>${esc(JSON.stringify({ resource: scopeKey, access: 'write' }))}</code><button class="iconbtn" title="Copy" data-copy="${esc(JSON.stringify({ resource: scopeKey, access: 'write' }))}">${icon('copy')}</button></div>`;
    $$('[data-copy]', box).forEach((b) => b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(b.dataset.copy); toast('Copied'); } catch { toast('Copy failed: select the text instead', 'warn'); }
    }));
    const nm = $('[data-a="member"]', box); if (nm) nm.addEventListener('click', () => newMember(x, nm));
  }

  async function drawChanges() {
    const body = $('[data-body]', view);
    let ops;
    try { ops = await api.dataOperations(S.opsLimit); } catch (err) { body.innerHTML = `<div class="banner bad">${errorText(err)}</div>`; return; }
    body.innerHTML = `<table><thead><tr><th>When</th><th>Change</th><th>Datasets</th><th>Status</th><th>Commit</th><th></th></tr></thead><tbody>
      ${ops.operations.map((o) => `<tr><td title="${esc(time(o.createdAt))}">${esc(ago(o.createdAt))}</td><td>${esc(o.action)}</td><td class="small">${esc((o.keys || []).join(', ') || (o.result && o.result.state) || '')}</td><td>${badge(o.status)}</td><td><code>${esc(short(o.commit || (o.result && o.result.to)))}</code></td>
        <td>${['pending-push', 'failed', 'blocked'].includes(o.status) && o.kind === 'mutation' ? `<button class="btn sm" data-retry="${esc(o.operationId)}">Retry</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">No changes yet.</td></tr>'}
      </tbody></table>${ops.operations.length >= S.opsLimit ? '<div class="row" style="justify-content:center;margin-top:14px"><button class="btn sm" data-more>Show more</button></div>' : ''}`;
    const more = $('[data-more]', body); if (more) more.addEventListener('click', () => { S.opsLimit += 50; drawChanges(); });
    $$('[data-retry]', body).forEach((b) => b.addEventListener('click', () => busy(b, 'Retrying', async () => {
      try { const op = await api.dataRetry(b.dataset.retry); toast(`Retry: ${esc(op.status)}`, op.status === 'succeeded' ? 'ok' : 'warn'); drawChanges(); } catch (err) { toast(errorText(err), 'bad'); }
    })));
  }

  async function newMember(coll, btn) {
    let id = '', text = '{\n  \n}';
    const ok = await modal({
      title: `New member of ${coll.key}`,
      wide: true,
      body: `<label class="f"><span>Id <em>becomes the key ${esc(coll.key)}.&lt;id&gt; and the file name</em></span><input class="in mono" data-id placeholder="e.g. 2027"></label>
        <label class="f"><span>Content (JSON)</span><textarea class="in mono" data-json rows="10">${esc(text)}</textarea></label>`,
      actions: [{ label: 'Cancel', value: false }, { label: 'Create member', value: true, kind: 'primary' }],
      onOpen: (el) => { $('[data-id]', el).addEventListener('input', (e) => { id = e.target.value.trim(); }); $('[data-json]', el).addEventListener('input', (e) => { text = e.target.value; }); }
    });
    if (!ok) return;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return toast('Ids are letters, digits, - and _', 'bad');
    let data;
    try { data = JSON.parse(text); } catch (err) { return toast(`Not valid JSON: ${esc(err.message)}`, 'bad'); }
    await busy(btn, 'Creating', async () => {
      try {
        toastSaved(await api.replace(`${coll.key}.${id}`, data, null), `Created ${esc(coll.key)}.${esc(id)}`);
        location.hash = `#/data/@${encodeURIComponent(S.group)}/${encodeURIComponent(`${coll.key}.${id}`)}`;
      } catch (err) { saveFailed(err); }
    });
  }

  async function newDataset() {
    const f = { kind: 'document', key: '', title: '', owner: 'manage', access: 'public', list: false, listField: 'items', idField: 'id', idPattern: '^[a-z0-9][a-z0-9_-]{0,63}$', initial: '' };
    const ok = await modal({
      title: 'New dataset',
      wide: true,
      body: `<div class="seg" data-kind style="margin-bottom:14px"><button type="button" data-v="document" class="on">One document</button><button type="button" data-v="collection">Collection (one file per member)</button></div>
        <p class="small muted" data-kindhint style="margin-bottom:14px"></p>
        <div class="f2"><label class="f"><span>Key <em>dots group it, e.g. f1.drivers</em></span><input class="in mono" name="key" placeholder="f1.drivers"></label>
          <label class="f"><span>Title</span><input class="in" name="title" placeholder="F1 drivers"></label></div>
        <div class="f2"><label class="f"><span>Owner app</span><select class="in" name="owner"><option value="manage">manage (the dashboard)</option>${apps.map((a) => `<option>${esc(a)}</option>`).join('')}</select></label>
          <label class="f"><span>Access</span><select class="in" name="access"><option value="public">Public read (anyone can GET)</option><option value="private">Private (token or admin only)</option></select></label></div>
        <label class="check"><input type="checkbox" class="toggle" name="list">Holds a list of items (adds per-item endpoints)</label>
        <div class="f2" data-listf hidden><label class="f"><span>List field</span><input class="in mono" name="listField" value="items"></label><label class="f"><span>Id field in each item</span><input class="in mono" name="idField" value="id"></label></div>
        <label class="f" data-pattern hidden><span>Member id pattern <em>regular expression</em></span><input class="in mono" name="idPattern" value="${esc(f.idPattern)}"></label>
        <label class="f" data-initial><span>First content (JSON, optional)</span><textarea class="in mono" name="initial" rows="5" placeholder="{}"></textarea></label>
        <p class="small muted" data-path></p>`,
      actions: [{ label: 'Cancel', value: false }, { label: 'Create dataset', value: true, kind: 'primary' }],
      onOpen: (el) => {
        const sync = () => {
          const v = (n) => { const i = el.querySelector(`[name="${n}"]`); return i.type === 'checkbox' ? i.checked : i.value; };
          Object.assign(f, { key: v('key').trim(), title: v('title').trim(), owner: v('owner'), access: v('access'), list: v('list'), listField: v('listField').trim(), idField: v('idField').trim(), idPattern: v('idPattern').trim(), initial: v('initial') });
          $('[data-listf]', el).hidden = !f.list;
          $('[data-pattern]', el).hidden = f.kind !== 'collection';
          $('[data-initial]', el).hidden = f.kind !== 'document';
          $('[data-kindhint]', el).textContent = f.kind === 'document'
            ? 'A single JSON file, like projects or home.latest. Apps read and replace it, or work item by item.'
            : 'A family of JSON files with the same shape, like f1.season (one per year). Members are created and deleted through the API.';
          const p = f.key ? `data/${f.key.split('.').join('/')}${f.kind === 'collection' ? '/<id>.json' : '.json'}` : '';
          $('[data-path]', el).innerHTML = p ? `Stored at <code>${esc(p)}</code> in bmb-data · endpoint <code>/api/v1/data/resources/${esc(f.key)}${f.kind === 'collection' ? '.&lt;id&gt;' : ''}</code>` : '';
        };
        $$('[data-kind] button', el).forEach((b) => b.addEventListener('click', () => { f.kind = b.dataset.v; $$('[data-kind] button', el).forEach((x) => x.classList.toggle('on', x === b)); sync(); }));
        el.addEventListener('input', sync);
        el.addEventListener('change', sync);
        sync();
      }
    });
    if (!ok) return;
    const spec = { key: f.key, title: f.title || f.key, owner: f.owner, kind: f.kind, access: f.access };
    if (f.list) spec.items = { pointer: f.listField ? `/${f.listField}` : '', idField: f.idField || 'id' };
    if (f.kind === 'collection') spec.idPattern = f.idPattern;
    if (f.kind === 'document' && f.initial.trim()) {
      try { spec.initial = JSON.parse(f.initial); } catch (err) { return toast(`First content is not valid JSON: ${esc(err.message)}`, 'bad'); }
    }
    await busy(null, `Creating ${f.key}`, async () => {
      try {
        const res = await api.createDataset(spec);
        toastSaved(res, `Dataset ${esc(f.key)} created`);
        location.hash = `#/data/@${encodeURIComponent(f.key.split('.')[0])}/${encodeURIComponent(f.key)}`;
      } catch (err) { saveFailed(err); }
    });
  }

  draw();
}

async function rawEditor(view, key, { reroute }) {
  const r = await api.read(key);
  const text = JSON.stringify(r.data, null, 2);
  const group = key.split('.')[0];
  view.innerHTML = `
    <div class="head"><div><div class="kicker"><a href="#/data/@${encodeURIComponent(group)}/${encodeURIComponent(key)}">Data · ${esc(group)}</a> · raw JSON</div><h1 class="mid">${esc(key)}</h1><p class="sub">Edits the whole document. The server validates it against the dataset's schema before anything is committed; the purpose-built editors are safer for everyday changes.</p></div></div>
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
