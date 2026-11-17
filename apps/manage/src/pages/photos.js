// Photos layout editor (resource `photos`). The canvas reproduces photos.beyondmebtw.com's grid exactly
// (PhotosBMB photos.css): column counts, row heights, gaps and the per-breakpoint span caps.
// All edits go to a working copy; one Save writes the whole document with its revision.

import { api } from '../api.js';
import { esc, cssUrl, icon, toast, toastSaved, saveFailed, busy, setDirtyCheck, confirmDialog, formDialog, modal, clone, same, $, $$ } from '../ui.js';
import { loadPhotos } from './content.js';

const DEVICES = {
  desktop: { label: 'Desktop', w: 1280, rule: 'wider than 1024px' },
  tablet: { label: 'Tablet', w: 960, rule: '≤ 1024px' },
  phone: { label: 'Phone', w: 640, rule: '≤ 720px' },
  small: { label: 'Small', w: 400, rule: '≤ 480px' }
};
// [columns, row height px, gap px] — copied from photos.css (.bento-grid / .series-image-grid + media queries)
const GRID = {
  series: { desktop: [4, 200, 10], tablet: [3, 180, 10], phone: [2, 170, 8], small: [1, 230, 8] },
  image: { desktop: [4, 150, 14], tablet: [3, 140, 14], phone: [2, 130, 10], small: [1, 230, 10] }
};
const clamp = (n) => Math.max(1, Math.min(4, parseInt(n, 10) || 1));
function effective(dev, c, r) { // what the site's media queries do to a span
  if (dev === 'small') return [1, 1];
  if (dev === 'phone') return [Math.min(c, 2), r];
  if (dev === 'tablet') return [Math.min(c, 3), r];
  return [c, r];
}
const orient = (img) => { const o = String((img && img.orientation) || '').toLowerCase(); return o === 'portrait' || o === 'square' ? o : 'landscape'; };
const defSpan = (img) => [orient(img) === 'landscape' ? 2 : 1, orient(img) === 'portrait' ? 2 : 1];
function spanOf(item, kind) {
  const g = (item && item.grid) || {};
  if (kind === 'series') return [clamp(g.colSpan), clamp(g.rowSpan)];
  const d = defSpan(item);
  return [clamp(g.colSpan || d[0]), clamp(g.rowSpan || d[1])];
}
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 40);
function detectOrientation(url) {
  return new Promise((resolve) => {
    const img = new Image();
    const t = setTimeout(() => resolve(null), 8000);
    img.onload = () => { clearTimeout(t); const r = img.naturalWidth / img.naturalHeight; resolve(r > 1.15 ? 'landscape' : r < 0.87 ? 'portrait' : 'square'); };
    img.onerror = () => { clearTimeout(t); resolve(null); };
    img.src = url;
  });
}

export async function render(view, parts, { reroute }) {
  const res = await loadPhotos();
  const doc = clone(res.data);
  doc.series = doc.series || [];
  const base = clone(doc);
  // Start the preview at the size of the screen being used (same breakpoints as the site).
  const vw = window.innerWidth;
  const startDevice = vw <= 480 ? 'small' : vw <= 720 ? 'phone' : vw <= 1024 ? 'tablet' : 'desktop';
  const P = { view: parts[1] && doc.series.some((s) => s.id === parts[1]) ? parts[1] : 'series', device: startDevice, sel: null };
  setDirtyCheck(() => !same(doc, base));

  const series = (id) => doc.series.find((s) => s.id === id);
  const kind = () => (P.view === 'series' ? 'series' : 'image');
  const list = () => (P.view === 'series' ? doc.series : series(P.view).images || (series(P.view).images = []));
  const renumber = () => { doc.series.forEach((s, i) => { s.order = i + 1; (s.images || []).forEach((im, j) => { im.order = j + 1; }); }); };
  const setHash = () => history.replaceState(null, '', `#/photos${P.view !== 'series' ? `/${encodeURIComponent(P.view)}` : ''}`);
  const changes = () => {
    // Count changed entities, for the save bar.
    let n = 0;
    const bs = new Map(base.series.map((s) => [s.id, s]));
    for (const s of doc.series) {
      const b = bs.get(s.id);
      if (!b) { n++; continue; }
      const { images: i1, ...r1 } = s; const { images: i2, ...r2 } = b;
      if (!same(r1, r2)) n++;
      const bi = new Map((i2 || []).map((x) => [x.id, x]));
      for (const im of i1 || []) if (!bi.has(im.id) || !same(im, bi.get(im.id))) n++;
      n += (i2 || []).filter((x) => !(i1 || []).some((y) => y.id === x.id)).length;
    }
    n += base.series.filter((s) => !series(s.id)).length;
    return n;
  };

  function draw() {
    const k = kind();
    const s = P.view !== 'series' ? series(P.view) : null;
    view.innerHTML = `
      <div class="head"><div><div class="kicker">photos.beyondmebtw.com</div><h1>Photos</h1>
        <p class="sub">Drag tiles to reorder, size them with the steppers or the inspector. The canvas uses the live site's exact grid, so each screen size shows what visitors get.</p></div>
        <div class="acts"><a class="btn" href="https://photos.beyondmebtw.com" target="_blank" rel="noopener">Open site ${icon('ext')}</a>
          ${s ? `<button class="btn primary" data-a="add-images">${icon('plus')}Add images</button>` : `<button class="btn primary" data-a="add-series">${icon('plus')}New series</button>`}</div></div>
      <div class="ptools">
        <div class="seg"><button data-v="series" class="${P.view === 'series' ? 'on' : ''}">All series</button>${doc.series.map((x) => `<button data-v="${esc(x.id)}" class="${P.view === x.id ? 'on' : ''}">${esc(x.title || x.id)}<small>${(x.images || []).length}</small></button>`).join('')}</div>
        <span class="spacer"></span>
        <div class="seg">${Object.entries(DEVICES).map(([d, v]) => `<button data-d="${d}" class="${P.device === d ? 'on' : ''}">${v.label}<small>${GRID[k][d][0]} col</small></button>`).join('')}</div>
      </div>
      <div class="pwrap">
        <div>
          <div class="stage"><div class="meta"><span data-meta></span><span data-scale></span></div><div class="fit" data-fit><div class="frame" data-frame><div class="pgrid" data-grid></div></div></div></div>
          <div class="savebar hidden" data-save><span class="pulse"></span><b data-savetxt></b><button class="btn ghost sm" data-a="discard">Discard</button><button class="btn primary sm" data-a="save">Save to bmb-data</button></div>
        </div>
        <aside class="card sticky insp" data-insp></aside>
      </div>`;
    $$('[data-v]', view).forEach((b) => b.addEventListener('click', () => { P.view = b.dataset.v; P.sel = null; setHash(); draw(); }));
    $$('[data-d]', view).forEach((b) => b.addEventListener('click', () => { P.device = b.dataset.d; draw(); }));
    const as = $('[data-a="add-series"]', view); if (as) as.addEventListener('click', addSeries);
    const ai = $('[data-a="add-images"]', view); if (ai) ai.addEventListener('click', (e) => addImages(e.currentTarget));
    $('[data-a="discard"]', view).addEventListener('click', async () => {
      if (!(await confirmDialog('Discard changes?', 'Undo every unsaved change on this page?', { confirmLabel: 'Discard', danger: true }))) return;
      doc.series = clone(base.series); P.sel = null; if (P.view !== 'series' && !series(P.view)) P.view = 'series'; draw();
    });
    $('[data-a="save"]', view).addEventListener('click', (e) => save(e.currentTarget));
    drawGrid();
  }

  function drawGrid() {
    const k = kind(), items = list(), dev = P.device, [cols, row, gap] = GRID[k][dev];
    const g = $('[data-grid]', view);
    g.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    g.style.gridAutoRows = `${row}px`;
    g.style.gap = `${gap}px`;
    g.style.gridAutoFlow = k === 'image' ? 'dense' : 'row';
    $('[data-frame]', view).style.width = `${DEVICES[dev].w}px`;
    $('[data-meta]', view).textContent = `${DEVICES[dev].label} · ${DEVICES[dev].rule} · ${cols} col × ${row}px rows · gap ${gap}px${k === 'image' ? ' · dense' : ''}`;
    g.innerHTML = items.map((it) => {
      const [c, r] = spanOf(it, k), [ec, er] = effective(dev, c, r), diff = ec !== c || er !== r;
      const url = k === 'series' ? it.thumbnail || (it.images && it.images[0] && it.images[0].url) : it.url;
      const title = k === 'series' ? it.title || it.id : it.description || it.id;
      const sub = k === 'series' ? `${(it.images || []).length} images` : orient(it);
      return `<div class="tile ${P.sel === it.id ? 'sel' : ''}" draggable="true" data-id="${esc(it.id)}" style="grid-column:span ${ec};grid-row:span ${er}">
        <div class="bg" style="background-image:${cssUrl(url)}"></div><div class="shade"></div>
        <span class="sz ${diff ? 'diff' : ''}" title="${diff ? `Set to ${c}×${r}; this screen size shows it as ${ec}×${er}` : 'width × height in grid cells'}">${c}×${r}${diff ? ` → ${ec}×${er}` : ''}</span>
        <div class="ctl"><span class="step"><button data-st="c" data-d="-1" ${c <= 1 ? 'disabled' : ''}>−</button><span>W${c}</span><button data-st="c" data-d="1" ${c >= 4 ? 'disabled' : ''}>+</button></span>
          <span class="step"><button data-st="r" data-d="-1" ${r <= 1 ? 'disabled' : ''}>−</button><span>H${r}</span><button data-st="r" data-d="1" ${r >= 4 ? 'disabled' : ''}>+</button></span></div>
        <div class="lab">${esc(title)}<small>${esc(sub)}</small></div></div>`;
    }).join('') + (k === 'series' ? '<button class="tile add" data-add>+ New series</button>' : '<button class="tile add" data-add>+ Add images</button>');
    wireTiles();
    const n = changes();
    $('[data-save]', view).classList.toggle('hidden', n === 0);
    $('[data-savetxt]', view).textContent = `${n} unsaved change${n === 1 ? '' : 's'}`;
    drawInspector();
    requestAnimationFrame(fit);
  }

  function setSpan(id, c, r) {
    const it = list().find((x) => x.id === id);
    if (!it) return;
    it.grid = { ...(it.grid || {}), colSpan: clamp(c), rowSpan: clamp(r) };
    drawGrid();
  }

  function wireTiles() {
    let dragId = null;
    const add = $('[data-add]', view);
    add.addEventListener('click', () => (kind() === 'series' ? addSeries() : addImages(null)));
    $$('.tile[data-id]', view).forEach((t) => {
      t.addEventListener('click', (e) => {
        const b = e.target.closest('.step button');
        const it = list().find((x) => x.id === t.dataset.id);
        if (b) { e.stopPropagation(); const [c, r] = spanOf(it, kind()); const d = +b.dataset.d; setSpan(it.id, b.dataset.st === 'c' ? c + d : c, b.dataset.st === 'r' ? r + d : r); return; }
        P.sel = it.id; drawGrid();
      });
      t.addEventListener('dblclick', () => { if (kind() === 'series') { P.view = t.dataset.id; P.sel = null; setHash(); draw(); } });
      $$('.step', t).forEach((s) => s.addEventListener('mousedown', (e) => e.stopPropagation()));
      t.addEventListener('dragstart', (e) => { dragId = t.dataset.id; t.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', dragId); } catch { /* old browsers */ } });
      t.addEventListener('dragend', () => { t.classList.remove('dragging'); $$('.tile', view).forEach((x) => x.classList.remove('drop')); });
      t.addEventListener('dragover', (e) => { e.preventDefault(); if (t.dataset.id !== dragId) t.classList.add('drop'); });
      t.addEventListener('dragleave', () => t.classList.remove('drop'));
      t.addEventListener('drop', (e) => {
        e.preventDefault();
        const l = list(), from = l.findIndex((x) => x.id === dragId), to = l.findIndex((x) => x.id === t.dataset.id);
        if (from < 0 || to < 0 || from === to) return;
        const [m] = l.splice(from, 1); l.splice(to, 0, m); renumber(); drawGrid();
      });
    });
  }

  function drawInspector() {
    const el = $('[data-insp]', view), k = kind();
    const it = list().find((x) => x.id === P.sel);
    if (!it) {
      const s = P.view !== 'series' ? series(P.view) : null;
      el.innerHTML = s
        ? `<h2>Series</h2><h3 style="margin-bottom:12px">${esc(s.title)}</h3>
           <p class="muted small" style="margin-bottom:14px">Click an image to size or edit it. Images with no size set use their orientation's default (landscape 2×1, portrait 1×2, square 1×1).</p>
           <div class="row"><button class="btn sm" data-a="edit-series">${icon('edit')}Series details</button><button class="btn sm" data-a="back">All series</button></div>`
        : `<h2>Nothing selected</h2><p class="muted">Click a tile to size it and see how it lands on every screen. Double-click a series to arrange its images.</p>
           <div class="kicker" style="margin:18px 0 8px">How sizing works</div><p class="muted small">W and H are grid cells (1–4). Desktop has 4 columns; tablets cap width at 3, phones at 2, and small phones show everything 1×1. A pink size badge means this screen shows the tile smaller than you set it.</p>`;
      const es = $('[data-a="edit-series"]', el); if (es) es.addEventListener('click', () => { P.sel = null; editSeriesDetails(series(P.view)); });
      const bk = $('[data-a="back"]', el); if (bk) bk.addEventListener('click', () => { P.view = 'series'; P.sel = null; setHash(); draw(); });
      return;
    }
    const [c, r] = spanOf(it, k);
    const presets = [[1, 1], [2, 1], [1, 2], [2, 2], [3, 2], [4, 2], [1, 3], [2, 3], [3, 3], [4, 3], [1, 4], [2, 4]];
    el.innerHTML = `
      <div class="pv" style="background-image:${cssUrl(k === 'series' ? it.thumbnail : it.url)}"></div>
      <div class="kicker">${k === 'series' ? `Series · ${(it.images || []).length} images` : `Image · ${esc(orient(it))}`}</div>
      <h3 style="margin:4px 0 14px">${esc(k === 'series' ? it.title : it.id)}</h3>
      <div class="kicker" style="margin-bottom:6px">Size</div>
      <div class="presets">${presets.map(([pc, pr]) => `<button data-p="${pc},${pr}" class="${pc === c && pr === r ? 'on' : ''}">${pc}×${pr}</button>`).join('')}</div>
      <div class="bigstep"><div><button data-s="c,-1">−</button><b>W ${c}</b><button data-s="c,1">+</button></div><div><button data-s="r,-1">−</button><b>H ${r}</b><button data-s="r,1">+</button></div></div>
      ${k === 'image' ? `<button class="btn sm ghost" data-a="reset" style="margin:-6px 0 12px">Reset to ${esc(orient(it))} default (${defSpan(it).join('×')})</button>` : ''}
      <div class="kicker" style="margin-bottom:4px">How it lands</div>
      <table class="lands">${Object.entries(DEVICES).map(([d, v]) => { const e = effective(d, c, r); return `<tr class="${d === P.device ? 'cur' : ''}"><td>${v.label} <span class="muted">${GRID[k][d][0]} col</span></td><td>${e[0]}×${e[1]}</td></tr>`; }).join('')}</table>
      ${k === 'series'
        ? `<div class="row"><button class="btn sm primary" data-a="open">Arrange images</button><button class="btn sm" data-a="details">${icon('edit')}Details</button><button class="btn sm danger" data-a="del">Delete</button></div>`
        : `<form data-f>
            <label class="f"><span>Description <em>shown in the lightbox</em></span><textarea class="in" name="description" rows="2">${esc(it.description || '')}</textarea></label>
            <label class="f"><span>Alt text <em>for screen readers</em></span><input class="in" name="alt" value="${esc(it.alt || '')}"></label>
            <div class="f2"><label class="f"><span>Orientation</span><select class="in" name="orientation">${['landscape', 'portrait', 'square'].map((o) => `<option ${o === orient(it) ? 'selected' : ''}>${o}</option>`).join('')}</select></label>
              <label class="f"><span>&nbsp;</span><button class="btn sm" type="button" data-a="detect" style="width:100%">Detect</button></label></div>
            <label class="f"><span>Image URL</span><input class="in mono" name="url" value="${esc(it.url)}"></label>
          </form>
          <div class="row"><button class="btn sm danger" data-a="del">Delete image</button></div>`}`;
    $$('[data-p]', el).forEach((b) => b.addEventListener('click', () => { const [pc, pr] = b.dataset.p.split(',').map(Number); setSpan(it.id, pc, pr); }));
    $$('[data-s]', el).forEach((b) => b.addEventListener('click', () => { const [a, d] = b.dataset.s.split(','); setSpan(it.id, a === 'c' ? c + +d : c, a === 'r' ? r + +d : r); }));
    const rs = $('[data-a="reset"]', el); if (rs) rs.addEventListener('click', () => { delete it.grid; drawGrid(); });
    const op = $('[data-a="open"]', el); if (op) op.addEventListener('click', () => { P.view = it.id; P.sel = null; setHash(); draw(); });
    const dt = $('[data-a="details"]', el); if (dt) dt.addEventListener('click', () => editSeriesDetails(it));
    $('[data-a="del"]', el).addEventListener('click', async () => {
      if (k === 'series') {
        const ok = await confirmDialog(`Delete “${esc(it.title)}”?`, `The series and its ${(it.images || []).length} image entries are removed from the photos page (the image files themselves stay where they are). Takes effect when you save.`, { confirmLabel: 'Delete series', danger: true });
        if (!ok) return;
        doc.series = doc.series.filter((x) => x.id !== it.id);
      } else {
        const s = series(P.view);
        s.images = s.images.filter((x) => x.id !== it.id);
      }
      P.sel = null; renumber(); drawGrid();
    });
    const f = $('[data-f]', el);
    if (f) {
      f.addEventListener('input', () => {
        const fd = new FormData(f);
        it.description = String(fd.get('description') || '');
        it.alt = String(fd.get('alt') || '');
        it.url = String(fd.get('url') || '').trim();
        const cnt = changes(); $('[data-save]', view).classList.toggle('hidden', cnt === 0); $('[data-savetxt]', view).textContent = `${cnt} unsaved change${cnt === 1 ? '' : 's'}`;
      });
      f.addEventListener('change', (e) => { if (e.target.name === 'orientation') { it.orientation = e.target.value; drawGrid(); } });
      $('[data-a="detect"]', el).addEventListener('click', async (e) => {
        const o = await busy(e.currentTarget, 'Loading', () => detectOrientation(it.url));
        if (!o) return toast('Could not load the image to measure it', 'bad');
        it.orientation = o; toast(`Detected ${o}`); drawGrid();
      });
    }
  }

  async function editSeriesDetails(s) {
    const v = await formDialog({ title: `Series: ${s.title}`, fields: [
      { name: 'title', label: 'Title', value: s.title || '' },
      { name: 'description', label: 'Description', value: s.description || '', type: 'textarea' },
      { name: 'thumbnail', label: 'Cover image URL (shown on the series tile)', value: s.thumbnail || '' },
      { name: 'rawLink', label: 'Originals link (e.g. Google Drive folder)', value: s.rawLink || '' },
      { name: 'rawLinkLabel', label: 'Originals link label', value: s.rawLinkLabel || '' }
    ] });
    if (!v) return;
    if (!v.title.trim()) return toast('A title is required', 'bad');
    Object.assign(s, { title: v.title.trim(), description: v.description.trim(), thumbnail: v.thumbnail.trim(), rawLink: v.rawLink.trim(), rawLinkLabel: v.rawLinkLabel.trim() });
    draw();
  }

  async function addSeries() {
    const v = await formDialog({ title: 'New series', submitLabel: 'Add series', fields: [
      { name: 'title', label: 'Title', value: '' },
      { name: 'id', label: 'Id (letters and digits; used in the page URL)', value: '', hint: 'Leave empty to derive it from the title.' },
      { name: 'thumbnail', label: 'Cover image URL', value: '' },
      { name: 'description', label: 'Description', value: '', type: 'textarea' }
    ] });
    if (!v) return;
    const title = v.title.trim();
    const id = slug(v.id || title);
    if (!title) return toast('A title is required', 'bad');
    if (!id) return toast('Could not make an id from that; type one', 'bad');
    if (series(id)) return toast(`A series with id "${id}" already exists`, 'bad');
    doc.series.push({ id, title, description: v.description.trim(), thumbnail: v.thumbnail.trim(), rawLink: '', rawLinkLabel: '', grid: { colSpan: 1, rowSpan: 2 }, order: doc.series.length + 1, images: [] });
    P.view = id; P.sel = null; setHash(); draw();
    toast('Series added. Now add its images, then save.');
  }

  async function addImages(btn) {
    const s = series(P.view);
    let raw = '';
    const ok = await modal({
      title: `Add images to ${s.title}`,
      wide: true,
      body: '<label class="f"><span>Image URLs, one per line</span><textarea class="in mono" data-urls rows="8" placeholder="https://content.beyondmebtw.com/assets/photos/…"></textarea></label><p class="hint">Each image is measured to set its orientation, and so its default size.</p>',
      actions: [{ label: 'Cancel', value: false }, { label: 'Add images', value: true, kind: 'primary' }],
      onOpen: (el) => { const ta = $('[data-urls]', el); ta.addEventListener('input', () => { raw = ta.value; }); }
    });
    if (!ok) return;
    const urls = [...new Set(raw.split(/\s+/).map((u) => u.trim()).filter((u) => /^https?:\/\//i.test(u)))];
    if (!urls.length) return toast('No image URLs found (they must start with http)', 'bad');
    const orients = await busy(btn, 'Measuring', () => Promise.all(urls.map(detectOrientation)));
    s.images = s.images || [];
    const taken = new Set(s.images.map((i) => i.id));
    let n = s.images.length;
    for (const [i, url] of urls.entries()) {
      let id;
      do { n += 1; id = `${s.id}_${n}`; } while (taken.has(id));
      taken.add(id);
      s.images.push({ id, url, description: '', alt: '', orientation: orients[i] || 'landscape', order: s.images.length + 1 });
    }
    const failed = orients.filter((o) => !o).length;
    drawGrid();
    toast(`Added ${urls.length} image${urls.length === 1 ? '' : 's'}${failed ? `; ${failed} could not be measured (set to landscape)` : ''}. Save to publish.`, failed ? 'warn' : 'ok');
  }

  async function save(btn) {
    renumber();
    await busy(btn, 'Saving', async () => {
      try {
        const r = await api.replace('photos', doc, res.revision);
        toastSaved(r, 'Photos saved');
        setDirtyCheck(null);
        reroute();
      } catch (err) { saveFailed(err, () => { setDirtyCheck(null); reroute(); }); }
    });
  }

  function fit() {
    const fitEl = $('[data-fit]', view), frame = $('[data-frame]', view);
    if (!fitEl || !frame) return;
    const w = DEVICES[P.device].w + 28, scale = Math.min(1, fitEl.clientWidth / w);
    frame.style.transform = `scale(${scale})`;
    fitEl.style.height = `${frame.offsetHeight * scale}px`;
    const sc = $('[data-scale]', view); if (sc) sc.textContent = scale < 1 ? `shown at ${Math.round(scale * 100)}%` : 'actual size';
  }
  const onResize = () => fit();
  window.addEventListener('resize', onResize);

  draw();
  return () => window.removeEventListener('resize', onResize);
}
