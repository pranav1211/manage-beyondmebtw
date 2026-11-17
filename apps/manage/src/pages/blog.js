// Blog: posts per category (blog.posts.<category> collection) + the category manifest (blog.categories).
// Structural changes (new/moved/deleted posts touching the homepage, category and subcategory edits)
// are single transactions: one commit, all or nothing.

import { api } from '../api.js';
import {
  esc, cssUrl, icon, prettyDate, isoDate, todayISO, toast, toastSaved, saveFailed, busy, setDirtyCheck,
  confirmDialog, modal, formDialog, clone, same, $, $$, sortable, move, revealOnMobile
} from '../ui.js';
import { loadBlog, loadHome, homeCard, homePlacement } from './content.js';

const KEY_RE = /^[a-z0-9]{2,40}$/;
const sanitizeKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// home.latest.categories keeps the latest post per (lower-cased) subcategory, as the old Manage did.
const homeSubKey = (s) => ({ 'tv shows': 'tv' })[String(s).toLowerCase()] ?? String(s).toLowerCase();

export async function render(view, parts, ctx) {
  if (parts[0] === 'categories') return categoriesPage(view, ctx);
  return postsPage(view, parts, ctx);
}

// ─────────────────────────────── posts ───────────────────────────────
async function postsPage(view, parts, { reroute }) {
  const [blog, home] = await Promise.all([loadBlog(), loadHome()]);
  const catKeys = Object.keys(blog.categories);
  if (!catKeys.length) {
    view.innerHTML = `<div class="head"><div><div class="kicker">blog.beyondmebtw.com</div><h1>Blog</h1></div></div><div class="empty big">No categories yet. <a href="#/categories">Create the first one</a>.</div>`;
    return;
  }
  const st = { cat: catKeys[0], sub: '', q: '', sel: null };
  if (parts[1] === 'new') st.sel = 'new';
  else if (parts[1] && blog.categories[parts[1]]) { st.cat = parts[1]; if (parts[2]) st.sel = parts[2] === 'new' ? 'new' : parts[2]; }
  let form = null; // working copy of the post being edited
  let formBase = null;
  setDirtyCheck(() => form !== null && formBase !== null && !same(form, formBase));

  const catName = (k) => (blog.categories[k] ? blog.categories[k].name : k);
  const posts = () => blog.posts[st.cat].data.posts || [];
  const setHash = () => history.replaceState(null, '', `#/blog/${encodeURIComponent(st.cat)}${st.sel ? `/${encodeURIComponent(st.sel)}` : ''}`);

  function blank() {
    return { uid: '', title: '', date: todayISO(), excerpt: '', thumbnail: '', link: '', subcategory: '', secondaryCategory: '', secondarySubcategory: '', category: st.cat, makeMain: false };
  }
  function openPost(uid) {
    st.sel = uid;
    if (uid === 'new') form = blank();
    else {
      const p = posts().find((x) => x.uid === uid);
      if (!p) { st.sel = null; form = null; formBase = null; return; }
      form = { ...p, subcategory: p.subcategory || '', secondaryCategory: p.secondaryCategory || '', secondarySubcategory: p.secondarySubcategory || '', category: st.cat };
    }
    formBase = null; // taken after the editor's first draw, which normalises the form
  }
  if (st.sel) openPost(st.sel);

  async function guardSwitch() {
    if (form && formBase && !same(form, formBase)) return confirmDialog('Unsaved changes', 'Discard the changes to this post?', { confirmLabel: 'Discard', danger: true });
    return true;
  }

  function draw() {
    const subs = blog.categories[st.cat].subcategories || [];
    const q = st.q.trim().toLowerCase();
    const list = posts()
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => (!st.sub || p.subcategory === st.sub) && (!q || `${p.title} ${p.excerpt || ''}`.toLowerCase().includes(q)))
      .sort((a, b) => (new Date(b.p.date).getTime() || 0) - (new Date(a.p.date).getTime() || 0) || b.i - a.i);
    view.innerHTML = `
      <div class="head"><div><div class="kicker">blog.beyondmebtw.com</div><h1>Blog</h1><p class="sub">Pick a category, find a post, edit it on the right. The card underneath the form shows how it looks on the blog.</p></div>
        <div class="acts"><a class="btn" href="#/categories">Categories</a><button class="btn primary" data-a="new">${icon('plus')}New post</button></div></div>
      <div class="tabs">${catKeys.map((k) => `<button class="tab ${k === st.cat ? 'on' : ''}" data-cat="${esc(k)}">${esc(catName(k))}<small>${(blog.posts[k].data.posts || []).length}</small></button>`).join('')}</div>
      <div class="row" style="margin-bottom:14px">
        <button class="chip ${st.sub === '' ? 'on' : ''}" data-sub="">All</button>${subs.map((s) => `<button class="chip ${st.sub === s ? 'on' : ''}" data-sub="${esc(s)}">${esc(s)}</button>`).join('')}
        <span class="spacer"></span><input class="in" style="max-width:300px" data-q placeholder="Search this category…" value="${esc(st.q)}">
      </div>
      <div class="split">
        <div class="list" data-list>${list.length ? list.map(({ p }) => {
          const place = homePlacement(home.data, p);
          return `<div class="li ${p.uid === st.sel ? 'sel' : ''}" data-uid="${esc(p.uid)}"><i class="th" style="background-image:${cssUrl(p.thumbnail)}"></i>
            <div class="tx"><b>${esc(p.title)}</b><span>${esc(prettyDate(p.date))}${p.subcategory ? ` · ${esc(p.subcategory)}` : ''}${p.secondaryCategory ? ` · also in ${esc(catName(p.secondaryCategory))}` : ''}</span></div>
            ${place ? `<span class="pill ${place === 'main' ? 'pink' : ''}">${esc(place === 'main' ? 'homepage main' : place)}</span>` : ''}</div>`;
        }).join('') : `<div class="empty">${posts().length ? 'No posts match.' : 'No posts in this category yet.'}</div>`}</div>
        <aside class="card sticky" data-editor></aside>
      </div>`;
    $$('[data-cat]', view).forEach((b) => b.addEventListener('click', async () => { if (!(await guardSwitch())) return; st.cat = b.dataset.cat; st.sub = ''; st.sel = null; form = null; formBase = null; setHash(); draw(); }));
    $$('[data-sub]', view).forEach((b) => b.addEventListener('click', () => { st.sub = b.dataset.sub; draw(); }));
    $('[data-q]', view).addEventListener('input', (e) => { st.q = e.target.value; const pos = e.target.selectionStart; draw(); const inp = $('[data-q]', view); inp.focus(); inp.setSelectionRange(pos, pos); });
    $$('[data-uid]', view).forEach((r) => r.addEventListener('click', async () => { if (r.dataset.uid === st.sel) return; if (!(await guardSwitch())) return; openPost(r.dataset.uid); setHash(); draw(); revealOnMobile($('[data-editor]', view)); }));
    $('[data-a="new"]', view).addEventListener('click', async () => { if (!(await guardSwitch())) return; openPost('new'); setHash(); draw(); revealOnMobile($('[data-editor]', view)); });
    drawEditor();
  }

  function drawEditor() {
    const box = $('[data-editor]', view);
    if (!form) {
      box.innerHTML = `<div class="empty">Select a post to edit it, or start a new one.<div style="margin-top:14px"><button class="btn primary" data-a="new2">${icon('plus')}New post</button></div></div>`;
      $('[data-a="new2"]', box).addEventListener('click', () => { openPost('new'); setHash(); draw(); });
      return;
    }
    const isNew = st.sel === 'new';
    const subsOf = (k) => (blog.categories[k] ? blog.categories[k].subcategories || [] : []);
    const original = !isNew ? posts().find((x) => x.uid === st.sel) : null;
    const place = original ? homePlacement(home.data, original) : null;
    box.innerHTML = `
      <h2>${isNew ? 'New post' : 'Edit post'}${isNew ? '' : `<span class="aside mono">${esc(form.uid)}</span>`}</h2>
      ${place ? `<div class="banner">On the homepage as <b>${esc(place === 'main' ? 'the main post' : place)}</b>. Saving also updates that homepage card.</div>` : ''}
      <form data-f>
        <label class="f"><span>Title</span><input class="in" name="title" value="${esc(form.title)}" required></label>
        <div class="f2">
          <label class="f"><span>Date</span><input class="in" type="date" name="date" value="${esc(isoDate(form.date))}" required></label>
          <label class="f"><span>Category</span><select class="in" name="category">${catKeys.map((k) => `<option value="${esc(k)}" ${k === form.category ? 'selected' : ''}>${esc(catName(k))}</option>`).join('')}</select></label>
        </div>
        <div class="f2">
          <label class="f"><span>Subcategory</span><select class="in" name="subcategory"><option value="">None</option>${subsOf(form.category).map((s) => `<option ${s === form.subcategory ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
          <label class="f"><span>Also show in</span><select class="in" name="secondaryCategory"><option value="">No other category</option>${catKeys.filter((k) => k !== form.category).map((k) => `<option value="${esc(k)}" ${k === form.secondaryCategory ? 'selected' : ''}>${esc(catName(k))}</option>`).join('')}</select></label>
        </div>
        ${form.secondaryCategory && subsOf(form.secondaryCategory).length ? `<label class="f"><span>Subcategory there</span><select class="in" name="secondarySubcategory"><option value="">None</option>${subsOf(form.secondaryCategory).map((s) => `<option ${s === form.secondarySubcategory ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label>` : ''}
        <label class="f"><span>Excerpt <em data-count></em></span><textarea class="in" name="excerpt" rows="4">${esc(form.excerpt)}</textarea></label>
        <label class="f"><span>Thumbnail URL</span><input class="in" name="thumbnail" value="${esc(form.thumbnail)}" placeholder="https://content.beyondmebtw.com/thumbnails/…"></label>
        <label class="f"><span>Link (Medium) ${form.link ? `<a href="${esc(form.link)}" target="_blank" rel="noopener">open ${icon('ext')}</a>` : ''}</span><input class="in" name="link" value="${esc(form.link)}" placeholder="https://medium.com/@beyondmebtw/…"></label>
        ${isNew ? `<label class="check"><input type="checkbox" class="toggle" name="makeMain" ${form.makeMain ? 'checked' : ''}>Also make it the homepage main post</label>` : ''}
        <div class="formbar">
          <button class="btn primary" type="submit">${isNew ? 'Publish post' : 'Save post'}</button>
          <button class="btn ghost" type="button" data-a="cancel">${isNew ? 'Cancel' : 'Revert'}</button>
          ${isNew ? '' : '<button class="btn danger" type="button" data-a="delete">Delete</button>'}
        </div>
      </form>
      ${isNew ? '' : `<div class="section"><h2>Homepage</h2><div class="row">
        <button class="btn sm" data-a="make-main" ${place === 'main' ? 'disabled' : ''}>Make main post</button>
        ${[1, 2, 3, 4].map((n) => `<button class="btn sm" data-a="feature" data-n="${n}" ${place === `featured ${n}` ? 'disabled' : ''}>Featured ${n}</button>`).join('')}
      </div><p class="hint">Saves the homepage immediately. To rearrange everything at once, use <a href="#/home">Homepage</a>.</p></div>`}
      <div class="section"><div class="kicker" style="margin-bottom:8px">Preview on the blog</div><div class="pcard" data-pv></div></div>`;

    const f = $('[data-f]', box);
    const sync = () => {
      const fd = new FormData(f);
      const date = String(fd.get('date') || '');
      const prev = clone(form);
      form.title = String(fd.get('title') || '');
      // Keep the stored date string as-is unless the user actually picked a different day.
      form.date = date && date !== isoDate(prev.date) ? date : prev.date;
      form.category = String(fd.get('category'));
      form.subcategory = String(fd.get('subcategory') || '');
      form.secondaryCategory = String(fd.get('secondaryCategory') || '');
      form.secondarySubcategory = !form.secondaryCategory ? '' : fd.has('secondarySubcategory') ? String(fd.get('secondarySubcategory') || '') : prev.secondarySubcategory || '';
      form.excerpt = String(fd.get('excerpt') || '');
      form.thumbnail = String(fd.get('thumbnail') || '').trim();
      form.link = String(fd.get('link') || '').trim();
      form.makeMain = fd.get('makeMain') === 'on';
      $('[data-count]', box).textContent = `${form.excerpt.length} characters`;
      $('[data-pv]', box).innerHTML = `<i style="background-image:${cssUrl(form.thumbnail)}"></i><div><b>${esc(form.title || 'Untitled')}</b><span>${esc(prettyDate(form.date))}${form.subcategory ? ` · ${esc(form.subcategory)}` : ''}</span><p>${esc(form.excerpt)}</p></div>`;
      return prev;
    };
    // What the form was drawn with; selects fire both input and change, so compare to this.
    const drawnCat = form.category, drawnSec = form.secondaryCategory;
    f.addEventListener('input', sync);
    f.addEventListener('change', () => {
      sync();
      // Category changes alter which subcategories/secondary options exist: redraw the form.
      if (drawnCat !== form.category || drawnSec !== form.secondaryCategory) {
        if (drawnCat !== form.category) { form.subcategory = ''; if (form.secondaryCategory === form.category) form.secondaryCategory = ''; }
        if (drawnSec !== form.secondaryCategory) form.secondarySubcategory = '';
        drawEditor();
      }
    });
    sync();
    if (formBase === null) formBase = clone(form);
    f.addEventListener('submit', (e) => { e.preventDefault(); save($('button[type=submit]', f)); });
    $('[data-a="cancel"]', box).addEventListener('click', () => { if (isNew) { form = null; formBase = null; st.sel = null; setHash(); draw(); } else { form = clone(formBase); drawEditor(); } });
    const del = $('[data-a="delete"]', box);
    if (del) del.addEventListener('click', () => remove(del, place));
    const mm = $('[data-a="make-main"]', box);
    if (mm) mm.addEventListener('click', () => placeOnHome(mm, original, 'main'));
    $$('[data-a="feature"]', box).forEach((b) => b.addEventListener('click', () => placeOnHome(b, original, +b.dataset.n - 1)));
  }

  function postRecord() {
    const p = { uid: form.uid, title: form.title.trim(), date: form.date, excerpt: form.excerpt.trim(), thumbnail: form.thumbnail, link: form.link, subcategory: form.subcategory };
    if (form.secondaryCategory) { p.secondaryCategory = form.secondaryCategory; if (form.secondarySubcategory) p.secondarySubcategory = form.secondarySubcategory; }
    // Keep any fields this editor doesn't know about.
    const original = st.sel !== 'new' ? posts().find((x) => x.uid === st.sel) : null;
    if (original) for (const [k, v] of Object.entries(original)) if (!(k in p) && !['secondaryCategory', 'secondarySubcategory'].includes(k)) p[k] = v;
    return p;
  }

  async function save(btn) {
    const isNew = st.sel === 'new';
    const missing = ['title', 'date', 'excerpt', 'thumbnail', 'link'].filter((k) => !String(form[k] || '').trim());
    if (missing.length) { toast(`Fill in: ${missing.join(', ')}`, 'bad'); return; }
    const reload = () => { setDirtyCheck(null); reroute(); };
    await busy(btn, isNew ? 'Publishing' : 'Saving', async () => {
      try {
        if (isNew) form.uid = `${form.category}_${Date.now()}`;
        const post = postRecord();
        const changes = [];
        const docOf = (k) => clone(blog.posts[k].data);
        const fromCat = st.cat, toCat = form.category;
        const homeDoc = clone(home.data);
        let homeChanged = false;

        if (isNew) {
          const d = docOf(toCat);
          d.posts.push(post);
          changes.push({ key: `blog.posts.${toCat}`, data: d, ifRevision: blog.posts[toCat].revision });
          // The latest post per subcategory (kept for parity with the old Manage).
          homeDoc.categories = homeDoc.categories || {};
          const c = (homeDoc.categories[toCat] = homeDoc.categories[toCat] || { subcategories: {} });
          const card = { uid: post.uid, title: post.title, thumbnail: post.thumbnail };
          if (post.subcategory && (blog.categories[toCat].subcategories || []).length) { c.subcategories = c.subcategories || {}; c.subcategories[homeSubKey(post.subcategory)] = { mainPost: card }; }
          else c.mainPost = card;
          if (form.makeMain) homeDoc.mainPost = homeCard(post);
          homeChanged = true;
        } else {
          const original = posts().find((x) => x.uid === st.sel);
          if (fromCat === toCat) {
            const d = docOf(fromCat);
            const i = d.posts.findIndex((x) => x.uid === post.uid);
            d.posts[i] = post;
            changes.push({ key: `blog.posts.${fromCat}`, data: d, ifRevision: blog.posts[fromCat].revision });
          } else {
            const a = docOf(fromCat), b = docOf(toCat);
            a.posts = a.posts.filter((x) => x.uid !== post.uid);
            b.posts.push(post);
            changes.push({ key: `blog.posts.${fromCat}`, data: a, ifRevision: blog.posts[fromCat].revision }, { key: `blog.posts.${toCat}`, data: b, ifRevision: blog.posts[toCat].revision });
          }
          // Keep the homepage card in sync when this post is on the homepage.
          const place = homePlacement(home.data, original);
          if (place) {
            const card = homeCard(post);
            if (place === 'main') homeDoc.mainPost = { ...homeDoc.mainPost, ...card };
            else { const n = +place.split(' ')[1] - 1; homeDoc.featured[n] = { ...homeDoc.featured[n], ...card }; }
            homeChanged = !same(homeDoc, home.data);
          }
        }
        if (homeChanged) changes.push({ key: 'home.latest', data: homeDoc, ifRevision: home.revision });
        const res = changes.length === 1 && !isNew
          ? await api.replace(changes[0].key, changes[0].data, changes[0].ifRevision)
          : await api.transaction(changes);
        toastSaved(res, isNew ? 'Post published' : 'Post saved');
        setDirtyCheck(null);
        location.hash = `#/blog/${encodeURIComponent(toCat)}/${encodeURIComponent(post.uid)}`;
        reroute();
      } catch (err) {
        if (isNew) form.uid = '';
        saveFailed(err, reload);
      }
    });
  }

  async function remove(btn, place) {
    const ok = await confirmDialog('Delete this post?', `“${esc(form.title)}” is removed from ${esc(catName(st.cat))}.${place ? ` <b>It is on the homepage as ${esc(place === 'main' ? 'the main post' : place)}</b>; the homepage keeps showing it until you change it there.` : ''} The change is a commit in bmb-data, so it can be recovered from history.`, { confirmLabel: 'Delete post', danger: true });
    if (!ok) return;
    await busy(btn, 'Deleting', async () => {
      try {
        const res = await api.deleteItem(`blog.posts.${st.cat}`, st.sel, blog.posts[st.cat].revision);
        toastSaved(res, 'Post deleted');
        setDirtyCheck(null);
        location.hash = `#/blog/${encodeURIComponent(st.cat)}`;
        reroute();
      } catch (err) {
        saveFailed(err, () => { setDirtyCheck(null); reroute(); });
      }
    });
  }

  async function placeOnHome(btn, post, where) {
    if (form && formBase && !same(form, formBase)) { toast('Save or revert your edits first', 'warn'); return; }
    const d = clone(home.data);
    d.featured = Array.isArray(d.featured) ? d.featured : [];
    while (d.featured.length < 4) d.featured.push({});
    const card = homeCard(post);
    if (where === 'main') d.mainPost = card;
    else {
      // If it was already featured elsewhere, swap so it isn't shown twice.
      const at = d.featured.findIndex((x) => x && x.link === post.link);
      if (at > -1 && at !== where) d.featured[at] = d.featured[where];
      d.featured[where] = card;
    }
    await busy(btn, 'Saving', async () => {
      try {
        const res = await api.replace('home.latest', d, home.revision);
        toastSaved(res, where === 'main' ? 'Now the homepage main post' : `Now featured in slot ${where + 1}`);
        reroute();
      } catch (err) {
        saveFailed(err, () => reroute());
      }
    });
  }

  draw();
}

// ─────────────────────────────── categories ───────────────────────────────
async function categoriesPage(view, { reroute }) {
  const [blog, home] = await Promise.all([loadBlog(), loadHome()]);
  const order = Object.keys(blog.categories);
  const count = (k) => (blog.posts[k].data.posts || []).length;
  const docOf = (k) => clone(blog.posts[k].data);
  const reload = () => reroute();

  // Posts in OTHER categories whose secondary category points at `cat` (and optionally subcategory `sub`).
  function secondaryRefs(cat, sub) {
    const out = [];
    for (const k of order) {
      if (k === cat) continue;
      const n = (blog.posts[k].data.posts || []).filter((p) => p.secondaryCategory === cat && (sub === undefined || p.secondarySubcategory === sub)).length;
      if (n) out.push([k, n]);
    }
    return out;
  }

  async function run(btn, label, changes, what) {
    await busy(btn, label, async () => {
      try {
        const res = changes.length === 1 ? await api.replace(changes[0].key, changes[0].data, changes[0].ifRevision) : await api.transaction(changes);
        toastSaved(res, what);
        reroute();
      } catch (err) {
        saveFailed(err, reload);
      }
    });
  }
  const catsChange = (cats) => ({ key: 'blog.categories', data: cats, ifRevision: blog.categoriesRevision });
  const fileChange = (k, data) => ({ key: `blog.posts.${k}`, data, ifRevision: blog.posts[k].revision });

  view.innerHTML = `
    <div class="head"><div><div class="kicker"><a href="#/blog">Blog</a></div><h1>Categories</h1><p class="sub">Categories and their subcategories. Drag to reorder how the blog lists them. Renames carry through to every post that uses them.</p></div>
      <div class="acts"><button class="btn primary" data-a="add">${icon('plus')}New category</button></div></div>
    <div class="list" data-cats>${order.map((k) => {
      const c = blog.categories[k];
      return `<div class="li" data-k="${esc(k)}" style="cursor:default;align-items:flex-start">
        <span class="grip" title="Drag to reorder">${icon('grip')}</span>
        <div class="tx"><b style="font-size:17px">${esc(c.name)}</b><span class="mono">${esc(k)} · ${count(k)} post${count(k) === 1 ? '' : 's'}${c.icon ? ` · ${esc(c.icon)}` : ''}</span>
          <div class="row" style="margin-top:10px">${(c.subcategories || []).map((s) => `<span class="chip">${esc(s)}<button class="iconbtn" style="width:22px;height:22px" title="Rename" data-a="sub-rename" data-k="${esc(k)}" data-s="${esc(s)}">${icon('edit')}</button><button class="x" title="Remove" data-a="sub-remove" data-k="${esc(k)}" data-s="${esc(s)}">×</button></span>`).join('')}
            <button class="btn sm" data-a="sub-add" data-k="${esc(k)}">${icon('plus')}Subcategory</button></div></div>
        <div class="row"><button class="btn sm" data-a="edit" data-k="${esc(k)}">${icon('edit')}Edit</button><button class="btn sm danger" data-a="delete" data-k="${esc(k)}">Delete</button></div>
      </div>`;
    }).join('') || '<div class="empty">No categories yet.</div>'}</div>`;

  sortable($('[data-cats]', view), '.li', async (from, to) => {
    const keys = move(order.slice(), from, to);
    const cats = {};
    for (const k of keys) cats[k] = blog.categories[k];
    await run(null, 'Saving', [catsChange(cats)], 'Category order saved');
  }, { handle: '.grip' });

  $$('[data-a]', view).forEach((b) => b.addEventListener('click', async () => {
    const a = b.dataset.a, k = b.dataset.k, s = b.dataset.s;
    const cats = clone(blog.categories);

    if (a === 'add') {
      const v = await formDialog({ title: 'New category', submitLabel: 'Create category', fields: [
        { name: 'name', label: 'Name', value: '' },
        { name: 'key', label: 'Key (lower-case letters and digits; used in URLs and file names)', value: '', hint: 'e.g. "gaming". Cannot be changed later.' },
        { name: 'icon', label: 'Icon (Font Awesome class)', value: 'fas fa-pen', hint: 'e.g. fas fa-film' },
        { name: 'subs', label: 'Subcategories (comma separated, optional)', value: '' }
      ] });
      if (!v) return;
      const key = sanitizeKey(v.key || v.name);
      if (!v.name.trim()) return toast('A name is required', 'bad');
      if (!KEY_RE.test(key) || key === 'categories') return toast('The key must be 2–40 lower-case letters or digits (and not "categories")', 'bad');
      if (cats[key]) return toast(`A category with key "${key}" already exists`, 'bad');
      const subs = [...new Set(v.subs.split(',').map((x) => x.trim()).filter(Boolean))];
      cats[key] = { name: v.name.trim(), icon: v.icon.trim(), subcategories: subs };
      return run(b, 'Creating', [catsChange(cats), { key: `blog.posts.${key}`, data: { subcategories: subs, posts: [] } }], `Category “${esc(v.name.trim())}” created`);
    }

    if (a === 'edit') {
      const v = await formDialog({ title: `Edit ${cats[k].name}`, fields: [{ name: 'name', label: 'Name', value: cats[k].name }, { name: 'icon', label: 'Icon (Font Awesome class)', value: cats[k].icon || '' }] });
      if (!v || !v.name.trim()) return;
      cats[k] = { ...cats[k], name: v.name.trim(), icon: v.icon.trim() };
      return run(b, 'Saving', [catsChange(cats)], 'Category saved');
    }

    if (a === 'delete') {
      const refs = secondaryRefs(k);
      const homeHas = home.data.categories && home.data.categories[k];
      const ok = await modal({
        title: `Delete ${cats[k].name}?`,
        typed: k,
        body: `<p class="lead">This deletes the category <b>and its ${count(k)} post${count(k) === 1 ? '' : 's'}</b> from the blog.</p>
          ${refs.length ? `<p>${refs.map(([c, n]) => `${n} post${n === 1 ? '' : 's'} in ${esc(cats[c].name)}`).join(', ')} also list it as a second category; that link is removed.</p>` : ''}
          <p class="muted small">One commit in bmb-data, so it can be recovered from history.</p>`,
        actions: [{ label: 'Cancel', value: false }, { label: 'Delete category', value: true, kind: 'danger' }]
      });
      if (!ok) return;
      delete cats[k];
      const changes = [catsChange(cats), { key: `blog.posts.${k}`, delete: true, ifRevision: blog.posts[k].revision }];
      for (const [c] of refs) {
        const d = docOf(c);
        d.posts.forEach((p) => { if (p.secondaryCategory === k) { delete p.secondaryCategory; delete p.secondarySubcategory; } });
        changes.push(fileChange(c, d));
      }
      if (homeHas) { const h = clone(home.data); delete h.categories[k]; changes.push({ key: 'home.latest', data: h, ifRevision: home.revision }); }
      return run(b, 'Deleting', changes, 'Category deleted');
    }

    if (a === 'sub-add') {
      const v = await formDialog({ title: `New subcategory in ${cats[k].name}`, fields: [{ name: 'name', label: 'Name', value: '' }] });
      const name = v && v.name.trim();
      if (!name) return;
      if ((cats[k].subcategories || []).includes(name)) return toast('That subcategory already exists', 'bad');
      cats[k].subcategories = [...(cats[k].subcategories || []), name];
      const d = docOf(k);
      d.subcategories = [...new Set([...(d.subcategories || []), name])];
      return run(b, 'Saving', [catsChange(cats), fileChange(k, d)], 'Subcategory added');
    }

    if (a === 'sub-rename') {
      const v = await formDialog({ title: `Rename “${s}”`, fields: [{ name: 'name', label: 'New name', value: s }] });
      const to = v && v.name.trim();
      if (!to || to === s) return;
      if ((cats[k].subcategories || []).includes(to)) return toast('That subcategory already exists', 'bad');
      cats[k].subcategories = cats[k].subcategories.map((x) => (x === s ? to : x));
      const d = docOf(k);
      d.subcategories = (d.subcategories || []).map((x) => (x === s ? to : x));
      d.posts.forEach((p) => { if (p.subcategory === s) p.subcategory = to; });
      const changes = [catsChange(cats), fileChange(k, d)];
      for (const [c] of secondaryRefs(k, s)) {
        const o = docOf(c);
        o.posts.forEach((p) => { if (p.secondaryCategory === k && p.secondarySubcategory === s) p.secondarySubcategory = to; });
        changes.push(fileChange(c, o));
      }
      return run(b, 'Renaming', changes, `Renamed to “${esc(to)}”`);
    }

    if (a === 'sub-remove') {
      const using = (blog.posts[k].data.posts || []).filter((p) => p.subcategory === s).length;
      const refs = secondaryRefs(k, s);
      const ok = await confirmDialog(`Remove “${esc(s)}”?`, `${using ? `${using} post${using === 1 ? '' : 's'} in it will have no subcategory.` : 'No posts use it.'}${refs.length ? ' Posts in other categories that point at it lose that subcategory link.' : ''}`, { confirmLabel: 'Remove subcategory', danger: true });
      if (!ok) return;
      cats[k].subcategories = cats[k].subcategories.filter((x) => x !== s);
      const d = docOf(k);
      d.subcategories = (d.subcategories || []).filter((x) => x !== s);
      d.posts.forEach((p) => { if (p.subcategory === s) p.subcategory = ''; });
      const changes = [catsChange(cats), fileChange(k, d)];
      for (const [c] of refs) {
        const o = docOf(c);
        o.posts.forEach((p) => { if (p.secondaryCategory === k && p.secondarySubcategory === s) delete p.secondarySubcategory; });
        changes.push(fileChange(c, o));
      }
      return run(b, 'Removing', changes, 'Subcategory removed');
    }
    return undefined;
  }));
}
