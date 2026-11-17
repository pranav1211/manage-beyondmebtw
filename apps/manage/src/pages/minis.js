// Minis: the list (minis.metadata, maintained by the Minis app) and homepage featuring.
// Writing and editing minis happens in the Minis editor, which owns that workflow.

import { api } from '../api.js';
import { esc, icon, toastSaved, saveFailed, busy, modal, clone, $, $$ } from '../ui.js';
import { loadMinis, loadHome } from './content.js';

export async function render(view, _parts, { reroute }) {
  const [minis, home] = await Promise.all([loadMinis(), loadHome()]);
  const st = { q: '', tag: '' };
  const tags = [...new Set(minis.data.flatMap((m) => m.tags || []))].sort();
  const slots = () => { const f = Array.isArray(home.data.featuredMinis) ? home.data.featuredMinis.slice(0, 3) : []; while (f.length < 3) f.push({}); return f; };

  async function setSlot(btn, index, mini) {
    const d = clone(home.data);
    d.featuredMinis = slots();
    if (mini) {
      const at = d.featuredMinis.findIndex((x) => x && x.id === mini.id);
      if (at > -1 && at !== index) d.featuredMinis[at] = d.featuredMinis[index];
      d.featuredMinis[index] = { id: mini.id, title: mini.title || '', date: mini.date || '', featuredExcerpt: mini.featuredExcerpt || '' };
    } else d.featuredMinis[index] = {};
    await busy(btn, 'Saving', async () => {
      try {
        toastSaved(await api.replace('home.latest', d, home.revision), mini ? `Featured in homepage slot ${index + 1}` : 'Removed from the homepage');
        reroute();
      } catch (err) { saveFailed(err, () => reroute()); }
    });
  }

  function draw() {
    const q = st.q.trim().toLowerCase();
    const featured = new Map(slots().map((s, i) => [s && s.id, i]));
    const shown = minis.data
      .filter((m) => (!st.tag || (m.tags || []).includes(st.tag)) && (!q || `${m.title} ${m.featuredExcerpt || ''}`.toLowerCase().includes(q)))
      .sort((a, b) => `${b.date} ${b.time || ''}`.localeCompare(`${a.date} ${a.time || ''}`));
    view.innerHTML = `
      <div class="head"><div><div class="kicker">minis.beyondmebtw.com</div><h1>Minis</h1><p class="sub">Short posts. Write and edit them in the Minis editor; choose which three the homepage features here.</p></div>
        <div class="acts"><a class="btn primary" href="https://minis.beyondmebtw.com/editor/" target="_blank" rel="noopener">Open the Minis editor ${icon('ext')}</a></div></div>
      <section class="card tint-yellow" style="margin-bottom:18px"><h2><span class="n">01</span>On the homepage</h2>
        <div class="slots three">${slots().map((s, i) => s && s.id
          ? `<div class="slot"><div class="sb"><div class="kicker">Slot ${i + 1} · ${esc(s.date)}</div><b>${esc(s.title)}</b></div><div class="sf"><button class="btn sm ghost" data-clear="${i}">Remove</button></div></div>`
          : `<div class="slot empty-slot"><div>Slot ${i + 1} is empty</div></div>`).join('')}</div></section>
      <div class="row" style="margin-bottom:14px">
        <button class="chip ${st.tag === '' ? 'on' : ''}" data-tag="">All</button>${tags.map((t) => `<button class="chip ${st.tag === t ? 'on' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`).join('')}
        <span class="spacer"></span><input class="in" style="max-width:300px" data-q placeholder="Search minis…" value="${esc(st.q)}">
      </div>
      <div class="list">${shown.map((m) => `<div class="li" style="cursor:default">
          <div class="tx"><b>${esc(m.title)}</b><span>${esc(m.date)}${m.time ? ` ${esc(m.time)}` : ''}${(m.tags || []).length ? ` · ${esc(m.tags.join(', '))}` : ''}</span>
            <span style="display:block;margin-top:4px">${esc(String(m.featuredExcerpt || '').slice(0, 200))}${String(m.featuredExcerpt || '').length > 200 ? '…' : ''}</span></div>
          ${featured.has(m.id) ? `<span class="pill pink">homepage ${featured.get(m.id) + 1}</span>` : `<button class="btn sm" data-feature="${esc(m.id)}">Feature</button>`}
          <a class="iconbtn" title="Open on the site" href="https://minis.beyondmebtw.com/post/${encodeURIComponent(m.id)}" target="_blank" rel="noopener">${icon('ext')}</a>
        </div>`).join('') || '<div class="empty">No minis match.</div>'}</div>`;
    $$('[data-tag]', view).forEach((b) => b.addEventListener('click', () => { st.tag = b.dataset.tag; draw(); }));
    $('[data-q]', view).addEventListener('input', (e) => { st.q = e.target.value; const p = e.target.selectionStart; draw(); const i = $('[data-q]', view); i.focus(); i.setSelectionRange(p, p); });
    $$('[data-clear]', view).forEach((b) => b.addEventListener('click', () => setSlot(b, +b.dataset.clear, null)));
    $$('[data-feature]', view).forEach((b) => b.addEventListener('click', async () => {
      const mini = minis.data.find((m) => m.id === b.dataset.feature);
      const cur = slots();
      const empty = cur.findIndex((s) => !s || !s.id);
      const index = empty > -1 ? empty : await modal({
        title: 'Replace which homepage mini?',
        body: '<p class="lead">All three homepage slots are taken.</p>',
        actions: [{ label: 'Cancel', value: null }, ...cur.map((s, i) => ({ label: `${i + 1}: ${String(s.title).slice(0, 28)}`, value: i }))]
      });
      if (index === null || index === undefined) return;
      setSlot(b, index, mini);
    }));
  }
  draw();
}
