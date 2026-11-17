// Projects showcase (resource `projects`: an array of projects, integer ids).
// Single-project edits are item writes; reordering and deletes that touch the homepage are whole-document/transaction writes.

import { api } from '../api.js';
import { esc, cssUrl, icon, toast, toastSaved, saveFailed, busy, setDirtyCheck, confirmDialog, formDialog, clone, same, $, $$, sortable, move, revealOnMobile } from '../ui.js';
import { loadProjects, loadHome } from './content.js';

const normImages = (imgs) => (Array.isArray(imgs) ? imgs : []).map((i) => (typeof i === 'string' ? { url: i, description: '' } : { url: String((i && i.url) || ''), description: String((i && i.description) || '') })).filter((i) => i.url);

export async function render(view, parts, { reroute }) {
  const [res, home] = await Promise.all([loadProjects(), loadHome()]);
  const list = clone(res.data);
  let order = list.map((p) => p.id);
  const baseOrder = order.slice();
  let sel = parts[1] === 'new' ? 'new' : parts[1] ? Number(parts[1]) : null;
  let form = null, formBase = null;
  setDirtyCheck(() => (form && !same(form, formBase)) || !same(order, baseOrder));

  const byId = (id) => list.find((p) => p.id === id);
  const categories = [...new Set(list.map((p) => p.category).filter(Boolean))];
  const featured = new Set((home.data.featuredProjects || []).map(Number));
  const setHash = () => history.replaceState(null, '', `#/projects${sel != null ? `/${sel}` : ''}`);

  function open(id) {
    sel = id;
    if (id === 'new') form = { id: Math.max(0, ...list.map((p) => Number(p.id) || 0)) + 1, title: '', shortDescription: '', fullDescription: '', logo: '', images: [], coverImage: '', link: '', githubLink: '', category: '', tags: [] };
    else {
      const p = byId(id);
      if (!p) { sel = null; form = null; formBase = null; return; }
      form = { ...clone(p), images: normImages(p.images), tags: Array.isArray(p.tags) ? p.tags.slice() : [], coverImage: p.coverImage || '' };
    }
    formBase = clone(form);
  }
  if (sel != null) open(sel);

  async function guard() {
    if (form && !same(form, formBase)) return confirmDialog('Unsaved changes', 'Discard the changes to this project?', { confirmLabel: 'Discard', danger: true });
    return true;
  }

  function draw() {
    const orderDirty = !same(order, baseOrder);
    view.innerHTML = `
      <div class="head"><div><div class="kicker">projects.beyondmebtw.com</div><h1>Projects</h1><p class="sub">Drag to change the showcase order. Select a project to edit it; the first image (or the one you star) is its cover.</p></div>
        <div class="acts"><a class="btn" href="https://projects.beyondmebtw.com" target="_blank" rel="noopener">Open site ${icon('ext')}</a><button class="btn primary" data-a="new">${icon('plus')}New project</button></div></div>
      <div class="split wide-right">
        <div>
          <div class="list" data-list>${order.map((id) => { const p = byId(id); return `<div class="li ${id === sel ? 'sel' : ''}" data-id="${id}"><span class="grip">${icon('grip')}</span><i class="th sq" style="background-image:${cssUrl(p.logo)};background-size:contain"></i>
            <div class="tx"><b>${esc(p.title)}</b><span>${esc(p.shortDescription || '')}</span></div><div class="tags">${featured.has(Number(id)) ? '<span class="pill pink">homepage</span>' : ''}${p.category ? `<span class="pill blue">${esc(p.category)}</span>` : ''}</div></div>`; }).join('')}</div>
          <div class="savebar ${orderDirty ? '' : 'hidden'}"><span class="pulse"></span><b>New order not saved</b><button class="btn ghost sm" data-a="order-reset">Reset</button><button class="btn primary sm" data-a="order-save">Save order</button></div>
        </div>
        <aside class="card sticky" data-ed></aside>
      </div>`;
    sortable($('[data-list]', view), '.li', (from, to) => { move(order, from, to); draw(); }, { handle: '.grip' });
    $$('[data-id]', view).forEach((r) => r.addEventListener('click', async (e) => { if (e.target.closest('.grip')) return; const id = Number(r.dataset.id); if (id === sel) return; if (!(await guard())) return; open(id); setHash(); draw(); revealOnMobile($('[data-ed]', view)); }));
    $('[data-a="new"]', view).addEventListener('click', async () => { if (!(await guard())) return; open('new'); setHash(); draw(); revealOnMobile($('[data-ed]', view)); });
    const rs = $('[data-a="order-reset"]', view); if (rs) rs.addEventListener('click', () => { order = baseOrder.slice(); draw(); });
    const sv = $('[data-a="order-save"]', view); if (sv) sv.addEventListener('click', () => saveOrder(sv));
    drawEditor();
  }

  function drawEditor() {
    const box = $('[data-ed]', view);
    if (!form) { box.innerHTML = '<div class="empty">Select a project to edit it, or add a new one.</div>'; return; }
    const isNew = sel === 'new';
    const cover = form.coverImage || (form.images[0] && form.images[0].url) || '';
    box.innerHTML = `
      <h2>${isNew ? 'New project' : 'Edit project'}<span class="aside mono">id ${esc(form.id)}</span></h2>
      <form data-f>
        <div class="f2"><label class="f"><span>Title</span><input class="in" name="title" value="${esc(form.title)}" required></label>
          <label class="f"><span>Category</span><input class="in" name="category" list="proj-cats" value="${esc(form.category || '')}"><datalist id="proj-cats">${categories.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></label></div>
        <label class="f"><span>Short description</span><input class="in" name="shortDescription" value="${esc(form.shortDescription || '')}"></label>
        <label class="f"><span>Full description <em>start lines with • for bullets</em></span><textarea class="in" name="fullDescription" rows="7">${esc(form.fullDescription || '')}</textarea></label>
        <div class="f2"><label class="f"><span>Live link</span><input class="in" name="link" value="${esc(form.link || '')}"></label>
          <label class="f"><span>GitHub link</span><input class="in" name="githubLink" value="${esc(form.githubLink || '')}"></label></div>
        <div class="f2" style="align-items:end"><label class="f"><span>Logo URL</span><input class="in" name="logo" value="${esc(form.logo || '')}"></label>
          <div style="margin-bottom:14px;height:40px;width:40px;background:${cssUrl(form.logo)} center/contain no-repeat" data-logo></div></div>
        <label class="f"><span>Tags <em>comma separated</em></span><input class="in" name="tags" value="${esc((form.tags || []).join(', '))}"></label>
      </form>
      <div class="kicker" style="margin:4px 0 8px">Images · drag to reorder · ★ = cover</div>
      <div class="imglist" data-imgs>${form.images.map((im, i) => `<div class="imgcell ${im.url === cover ? 'cover' : ''}" data-i="${i}">
          <div class="pv" style="background-image:${cssUrl(im.url)}"></div>
          ${im.url === cover ? '<span class="pill cv">cover</span>' : ''}
          <div class="ib"><button class="iconbtn ${im.url === cover ? 'on' : ''}" title="Use as cover" data-img="cover" data-i="${i}">${icon('star')}</button><button class="iconbtn" title="Caption" data-img="caption" data-i="${i}">${icon('edit')}</button><span class="spacer"></span><button class="iconbtn" title="Remove" data-img="remove" data-i="${i}">${icon('trash')}</button></div>
        </div>`).join('')}</div>
      <div class="row" style="margin-bottom:6px"><input class="in" data-newimg placeholder="Paste an image URL and press Add" style="flex:1"><button class="btn sm" data-a="img-add">${icon('plus')}Add</button></div>
      <div class="formbar">
        <button class="btn primary" data-a="save">${isNew ? 'Add project' : 'Save project'}</button>
        <button class="btn ghost" data-a="revert">${isNew ? 'Cancel' : 'Revert'}</button>
        ${isNew ? '' : '<button class="btn danger" data-a="delete">Delete</button>'}
      </div>`;
    const f = $('[data-f]', box);
    f.addEventListener('input', () => {
      const fd = new FormData(f);
      for (const k of ['title', 'category', 'shortDescription', 'fullDescription', 'link', 'githubLink', 'logo']) form[k] = String(fd.get(k) || '');
      form.tags = String(fd.get('tags') || '').split(',').map((t) => t.trim()).filter(Boolean);
      $('[data-logo]', box).style.backgroundImage = cssUrl(form.logo.trim());
    });
    f.addEventListener('submit', (e) => e.preventDefault());
    sortable($('[data-imgs]', box), '.imgcell', (from, to) => { move(form.images, from, to); drawEditor(); });
    $$('[data-img]', box).forEach((b) => b.addEventListener('click', async () => {
      const i = +b.dataset.i, im = form.images[i];
      if (b.dataset.img === 'cover') form.coverImage = im.url;
      else if (b.dataset.img === 'remove') { if (form.coverImage === im.url) form.coverImage = ''; form.images.splice(i, 1); }
      else { const v = await formDialog({ title: 'Image caption', fields: [{ name: 'description', label: 'Caption (shown in the project viewer)', value: im.description }, { name: 'url', label: 'Image URL', value: im.url }] }); if (!v) return; if (form.coverImage === im.url) form.coverImage = v.url.trim(); form.images[i] = { url: v.url.trim(), description: v.description.trim() }; }
      drawEditor();
    }));
    const add = () => { const inp = $('[data-newimg]', box); const u = inp.value.trim(); if (!u) return; form.images.push({ url: u, description: '' }); drawEditor(); };
    $('[data-a="img-add"]', box).addEventListener('click', add);
    $('[data-newimg]', box).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    $('[data-a="revert"]', box).addEventListener('click', () => { if (isNew) { form = null; formBase = null; sel = null; setHash(); draw(); } else { form = clone(formBase); drawEditor(); } });
    $('[data-a="save"]', box).addEventListener('click', (e) => save(e.currentTarget));
    const del = $('[data-a="delete"]', box); if (del) del.addEventListener('click', () => remove(del));
  }

  function record() {
    const p = { ...form, title: form.title.trim(), images: form.images.map((i) => ({ url: i.url, description: i.description })) };
    p.id = Number(p.id);
    if (!p.coverImage) delete p.coverImage;
    for (const k of ['category', 'githubLink', 'link']) if (!p[k]) delete p[k];
    return p;
  }

  async function save(btn) {
    if (!form.title.trim()) return toast('A title is required', 'bad');
    if (!same(order, baseOrder)) return toast('Save or reset the new order first', 'warn');
    const isNew = sel === 'new';
    await busy(btn, 'Saving', async () => {
      try {
        const p = record();
        const r = isNew ? await api.createItem('projects', p, res.revision) : await api.updateItem('projects', String(p.id), p, res.revision);
        toastSaved(r, isNew ? 'Project added' : 'Project saved');
        setDirtyCheck(null);
        location.hash = `#/projects/${p.id}`;
        reroute();
      } catch (err) { saveFailed(err, () => { setDirtyCheck(null); reroute(); }); }
    });
  }

  async function remove(btn) {
    const onHome = featured.has(Number(form.id));
    const ok = await confirmDialog('Delete this project?', `“${esc(form.title)}” is removed from the showcase.${onHome ? ' It is also removed from the homepage’s featured projects.' : ''}`, { confirmLabel: 'Delete project', danger: true });
    if (!ok) return;
    await busy(btn, 'Deleting', async () => {
      try {
        let r;
        if (onHome) {
          const h = clone(home.data);
          h.featuredProjects = (h.featuredProjects || []).filter((x) => Number(x) !== Number(form.id));
          r = await api.transaction([{ key: 'projects', data: list.filter((p) => p.id !== form.id), ifRevision: res.revision }, { key: 'home.latest', data: h, ifRevision: home.revision }]);
        } else r = await api.deleteItem('projects', String(form.id), res.revision);
        toastSaved(r, 'Project deleted');
        setDirtyCheck(null);
        location.hash = '#/projects';
        reroute();
      } catch (err) { saveFailed(err, () => { setDirtyCheck(null); reroute(); }); }
    });
  }

  async function saveOrder(btn) {
    if (form && !same(form, formBase)) return toast('Save or revert the open project first', 'warn');
    await busy(btn, 'Saving', async () => {
      try {
        const r = await api.replace('projects', order.map((id) => byId(id)), res.revision);
        toastSaved(r, 'Order saved');
        setDirtyCheck(null);
        reroute();
      } catch (err) { saveFailed(err, () => { setDirtyCheck(null); reroute(); }); }
    });
  }

  draw();
}
