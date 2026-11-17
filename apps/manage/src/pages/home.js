// Homepage editor (home.latest): main post, 4 featured posts, 4 featured projects, 3 featured minis.
// Edits happen on a working copy; one Save writes the whole document (with its revision).

import { api } from '../api.js';
import { esc, cssUrl, icon, prettyDate, pick, formDialog, toastSaved, saveFailed, busy, setDirtyCheck, clone, same, $, $$, sortable, move } from '../ui.js';
import { loadHome, loadBlog, loadProjects, loadMinis, allPosts, homeCard } from './content.js';

const FEATURED = 4, PROJECTS = 4, MINIS = 3;
const pad = (arr, n, fill) => { const a = Array.isArray(arr) ? arr.slice(0, n) : []; while (a.length < n) a.push(fill()); return a; };
const isEmpty = (o) => !o || !Object.values(o).some((v) => v !== '' && v != null);

export async function render(view, _parts, { reroute }) {
  const [home, blog, projects, minis] = await Promise.all([loadHome(), loadBlog(), loadProjects(), loadMinis().catch(() => ({ data: [] }))]);
  const posts = allPosts(blog);
  const original = clone(home.data);
  const doc = clone(home.data);
  doc.featured = pad(doc.featured, FEATURED, () => ({}));
  doc.featuredProjects = Array.isArray(doc.featuredProjects) ? doc.featuredProjects.slice(0, PROJECTS) : [];
  doc.featuredMinis = pad(doc.featuredMinis, MINIS, () => ({}));
  const baseline = clone(doc);
  setDirtyCheck(() => !same(doc, baseline));

  const postPicker = (title) => pick({
    title,
    placeholder: 'Search posts by title…',
    items: posts.map((p) => ({ id: `${p.category}/${p.uid}`, text: `${p.title} ${p.category} ${p.subcategory || ''}`, html: `<i class="th" style="background-image:${cssUrl(p.thumbnail)}"></i><div class="tx"><b>${esc(p.title)}</b><span>${esc(prettyDate(p.date))} · ${esc(blog.categories[p.category] ? blog.categories[p.category].name : p.category)}${p.subcategory ? ` · ${esc(p.subcategory)}` : ''}</span></div>` }))
  }).then((id) => (id ? posts.find((p) => `${p.category}/${p.uid}` === id) : null));

  const editCard = async (card, title) => {
    const v = await formDialog({
      title,
      fields: [
        { name: 'title', label: 'Title', value: card.title },
        { name: 'date', label: 'Date', value: card.date, hint: 'As shown on the homepage, e.g. 2026-10-26' },
        { name: 'excerpt', label: 'Excerpt', value: card.excerpt, type: 'textarea' },
        { name: 'thumbnail', label: 'Thumbnail URL', value: card.thumbnail },
        { name: 'link', label: 'Link', value: card.link }
      ]
    });
    return v ? { title: v.title.trim(), date: v.date.trim(), excerpt: v.excerpt.trim(), thumbnail: v.thumbnail.trim(), link: v.link.trim() } : null;
  };

  const cardHTML = (c, actions) => isEmpty(c)
    ? `<div class="slot empty-slot"><div>Empty slot</div><div class="sf" style="padding-top:10px">${actions}</div></div>`
    : `<div class="slot"><div class="thumb" style="background-image:${cssUrl(c.thumbnail)}"></div><div class="sb"><b>${esc(c.title)}</b><span>${esc(prettyDate(c.date))}</span></div><div class="sf">${actions}</div></div>`;

  function draw() {
    const m = doc.mainPost || {};
    const dirty = !same(doc, baseline);
    const projById = new Map(projects.data.map((p) => [String(p.id), p]));
    view.innerHTML = `
      <div class="head"><div><div class="kicker">beyondmebtw.com</div><h1>Homepage</h1><p class="sub">Choose what the front page shows. Pick from your posts, projects and minis, then save once.</p></div>
        <div class="acts"><a class="btn" href="https://beyondmebtw.com" target="_blank" rel="noopener">Open site ${icon('ext')}</a></div></div>

      <section class="card"><h2><span class="n">01</span>Main post</h2>
        <div class="mainslot">
          <div class="thumb" style="background-image:${cssUrl(m.thumbnail)}"></div>
          <div><div class="kicker">${esc(prettyDate(m.date))}</div><h3 style="margin:6px 0 8px">${esc(m.title || 'No main post')}</h3><p class="muted">${esc(m.excerpt || '')}</p>
            <div class="row" style="margin-top:14px"><button class="btn primary sm" data-a="main-pick">Pick a post</button><button class="btn sm" data-a="main-edit">${icon('edit')}Edit text</button></div></div>
        </div></section>

      <section class="card"><h2><span class="n">02</span>Featured posts<span class="aside">Drag to reorder</span></h2>
        <div class="slots" data-sort="featured">${doc.featured.map((f, i) => `<div class="slotwrap" data-i="${i}">${cardHTML(f, `<button class="btn sm" data-a="feat-pick" data-i="${i}">${isEmpty(f) ? 'Pick' : 'Replace'}</button>${isEmpty(f) ? '' : `<button class="btn sm ghost" data-a="feat-edit" data-i="${i}">Edit</button><button class="btn sm ghost" data-a="feat-clear" data-i="${i}">Clear</button>`}`)}</div>`).join('')}</div></section>

      <section class="card"><h2><span class="n">03</span>Featured projects<span class="aside">Drag to reorder</span></h2>
        <div class="slots" data-sort="projects">${pad(doc.featuredProjects, PROJECTS, () => null).map((id, i) => { const p = id != null ? projById.get(String(id)) : null; return `<div class="slotwrap" data-i="${i}">${p
          ? `<div class="slot"><div class="thumb" style="background-image:${cssUrl(p.coverImage || (p.images && p.images[0]) || p.logo)}"></div><div class="sb"><b>${esc(p.title)}</b><span>${esc(p.shortDescription || '')}</span></div><div class="sf"><button class="btn sm" data-a="proj-pick" data-i="${i}">Replace</button><button class="btn sm ghost" data-a="proj-clear" data-i="${i}">Clear</button></div></div>`
          : `<div class="slot empty-slot"><div>${id != null ? `Unknown project id ${esc(id)}` : 'Empty slot'}</div><div class="sf" style="padding-top:10px"><button class="btn sm" data-a="proj-pick" data-i="${i}">Pick</button></div></div>`}</div>`; }).join('')}</div></section>

      <section class="card"><h2><span class="n">04</span>Featured minis<span class="aside">Drag to reorder</span></h2>
        <div class="slots three" data-sort="minis">${doc.featuredMinis.map((mi, i) => `<div class="slotwrap" data-i="${i}">${isEmpty(mi)
          ? `<div class="slot empty-slot"><div>Empty slot</div><div class="sf" style="padding-top:10px"><button class="btn sm" data-a="mini-pick" data-i="${i}">Pick</button></div></div>`
          : `<div class="slot"><div class="sb"><div class="kicker">${esc(mi.date)}</div><b>${esc(mi.title)}</b><span>${esc(String(mi.featuredExcerpt || '').slice(0, 160))}${String(mi.featuredExcerpt || '').length > 160 ? '…' : ''}</span></div><div class="sf"><button class="btn sm" data-a="mini-pick" data-i="${i}">Replace</button><button class="btn sm ghost" data-a="mini-clear" data-i="${i}">Clear</button></div></div>`}</div>`).join('')}</div></section>

      <section class="card tint-blue"><h2><span class="n">05</span>Recent posts<span class="aside">Automatic · the site shows the first 4</span></h2>
        <p class="small muted" style="margin-bottom:12px">Worked out by Manage whenever a post, a category or this page changes: the newest posts that aren't already the main post or featured.${original.recentGeneratedAt ? ` Last changed ${esc(new Date(original.recentGeneratedAt).toLocaleString())}.` : ''}</p>
        ${Array.isArray(original.recent) && original.recent.length
          ? `<div class="list">${original.recent.map((r, i) => `<div class="li" style="cursor:default${i >= 4 ? ';opacity:.55' : ''}"><i class="th" style="background-image:${cssUrl(r.thumbnail)}"></i><div class="tx"><b>${esc(r.title)}</b><span>${esc(prettyDate(r.date))} · ${esc(r.categoryName)}${i >= 4 ? ' · spare' : ''}</span></div></div>`).join('')}</div>`
          : '<div class="empty">Not worked out yet; it appears after the next change.</div>'}
      </section>

      <div class="savebar ${dirty ? '' : 'hidden'}"><span class="pulse"></span><b>Unsaved homepage changes</b><button class="btn ghost sm" data-a="discard">Discard</button><button class="btn primary sm" data-a="save">Save homepage</button></div>`;

    $$('[data-a]', view).forEach((b) => b.addEventListener('click', () => act(b.dataset.a, +b.dataset.i, b)));
    for (const [name, arr] of [['featured', doc.featured], ['projects', null], ['minis', doc.featuredMinis]]) {
      const box = $(`[data-sort="${name}"]`, view);
      sortable(box, '.slotwrap', (from, to) => {
        if (name === 'projects') { const a = pad(doc.featuredProjects, PROJECTS, () => null); move(a, from, to); doc.featuredProjects = a.filter((x) => x != null); }
        else move(arr, from, to);
        draw();
      });
    }
  }

  async function act(a, i, btn) {
    if (a === 'main-pick') { const p = await postPicker('Main post'); if (p) { doc.mainPost = homeCard(p); draw(); } }
    else if (a === 'main-edit') { const c = await editCard(doc.mainPost || {}, 'Main post text'); if (c) { doc.mainPost = c; draw(); } }
    else if (a === 'feat-pick') {
      const p = await postPicker(`Featured slot ${i + 1}`);
      if (p) {
        // Already featured in another slot? Swap, so a post is never shown twice.
        const at = doc.featured.findIndex((f, j) => j !== i && f && f.link && f.link === p.link);
        if (at > -1) doc.featured[at] = doc.featured[i];
        doc.featured[i] = homeCard(p);
        draw();
      }
    }
    else if (a === 'feat-edit') { const c = await editCard(doc.featured[i], `Featured slot ${i + 1}`); if (c) { doc.featured[i] = c; draw(); } }
    else if (a === 'feat-clear') { doc.featured[i] = {}; draw(); }
    else if (a === 'proj-pick') {
      const id = await pick({ title: `Featured project ${i + 1}`, items: projects.data.map((p) => ({ id: String(p.id), text: `${p.title} ${p.shortDescription || ''}`, html: `<i class="th sq" style="background-image:${cssUrl(p.logo)}"></i><div class="tx"><b>${esc(p.title)}</b><span>${esc(p.shortDescription || '')}</span></div>` })) });
      if (id != null) {
        const a2 = pad(doc.featuredProjects, PROJECTS, () => null);
        const n = Number(id);
        const dup = a2.indexOf(n);
        if (dup > -1 && dup !== i) a2[dup] = a2[i];
        a2[i] = n;
        doc.featuredProjects = a2.filter((x) => x != null);
        draw();
      }
    } else if (a === 'proj-clear') { const a2 = pad(doc.featuredProjects, PROJECTS, () => null); a2[i] = null; doc.featuredProjects = a2.filter((x) => x != null); draw(); }
    else if (a === 'mini-pick') {
      const id = await pick({ title: `Featured mini ${i + 1}`, items: minis.data.map((x) => ({ id: x.id, text: `${x.title} ${(x.tags || []).join(' ')}`, html: `<div class="tx"><b>${esc(x.title)}</b><span>${esc(x.date)}${x.tags && x.tags.length ? ` · ${esc(x.tags.join(', '))}` : ''}</span></div>` })) });
      const x = id && minis.data.find((y) => y.id === id);
      if (x) { doc.featuredMinis[i] = { id: x.id, title: x.title || '', date: x.date || '', featuredExcerpt: x.featuredExcerpt || '' }; draw(); }
    } else if (a === 'mini-clear') { doc.featuredMinis[i] = {}; draw(); }
    else if (a === 'discard') { Object.keys(doc).forEach((k) => delete doc[k]); Object.assign(doc, clone(baseline)); draw(); }
    else if (a === 'save') {
      const out = { ...clone(original), ...clone(doc) };
      await busy(btn, 'Saving', async () => {
        try {
          const res = await api.replace('home.latest', out, home.revision);
          toastSaved(res, 'Homepage saved');
          setDirtyCheck(null);
          reroute();
        } catch (err) {
          saveFailed(err, () => { setDirtyCheck(null); reroute(); });
        }
      });
    }
  }

  draw();
}
