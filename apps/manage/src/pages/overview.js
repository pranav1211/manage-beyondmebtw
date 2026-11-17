import { api } from '../api.js';
import { esc, cssUrl, ago, prettyDate, icon } from '../ui.js';
import { loadBlog, loadHome, loadProjects, loadPhotos, loadMinis } from './content.js';
import { byPriority } from './apps.js';

const dotFor = (s) => (s === 'succeeded' ? '' : s === 'failed' || s === 'blocked' ? 'bad' : s === 'running' || s === 'pending' ? 'warn' : 'unknown');

function describeDataOp(o) {
  const keys = (o.keys || []).join(', ');
  const verb = { 'resource.replace': 'Saved', 'resource.create-item': 'Added an item to', 'resource.update-item': 'Edited an item in', 'resource.delete-item': 'Removed an item from', 'resource.transaction': 'Saved', 'resource.create': 'Created', 'resource.delete': 'Deleted' }[o.action];
  return verb ? `${verb} <code>${esc(keys)}</code>` : `${esc(o.action || o.kind || 'data')} <code>${esc(keys)}</code>`;
}

export async function render(view) {
  const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
  const [home, blog, projects, photos, minis, reg, ops, dops] = await Promise.all([
    settle(loadHome()), settle(loadBlog()), settle(loadProjects()), settle(loadPhotos()), settle(loadMinis()),
    settle(api.registry()), settle(api.operations(undefined, 100)), settle(api.dataOperations(15))
  ]);

  const h = home.ok ? home.v.data : null;
  const m = h && h.mainPost;
  const postCount = blog.ok ? Object.values(blog.v.posts).reduce((a, d) => a + (d.data.posts || []).length, 0) : null;
  const catCount = blog.ok ? Object.keys(blog.v.categories).length : null;
  const series = photos.ok ? photos.v.data.series || [] : [];
  const imgCount = series.reduce((a, s) => a + (s.images || []).length, 0);

  const latest = new Map();
  if (ops.ok) for (const o of ops.v.operations) if (!latest.has(o.application)) latest.set(o.application, o);
  const apps = reg.ok ? byPriority(reg.v.applications) : [];
  const failing = apps.filter((a) => { const o = latest.get(a.application); return o && (o.status === 'failed' || o.status === 'blocked'); });

  const activity = [
    ...(dops.ok ? dops.v.operations.map((o) => ({ at: o.createdAt, html: `${describeDataOp(o)}${o.status !== 'succeeded' && o.status !== 'noop' ? ` <span class="badge s-${esc(o.status)}">${esc(o.status)}</span>` : ''}` })) : []),
    ...(ops.ok ? ops.v.operations.slice(0, 15).map((o) => ({ at: o.createdAt, html: `<a href="#/ops/${encodeURIComponent(o.operationId)}">${esc(o.operation)}</a> ${esc(o.application)} <span class="badge s-${esc(o.status)}">${esc(o.result && o.result.noop ? 'no-op' : o.status)}</span>` })) : [])
  ].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 9);

  const thumbs = series.flatMap((s) => [s.thumbnail, ...(s.images || []).map((i) => i.url)]).filter(Boolean).slice(0, 9);

  view.innerHTML = `
    <div class="head"><div><div class="kicker">beyondmebtw.com</div><h1>Overview</h1><p class="sub">What's live on the site right now, and the fastest way to change it.</p></div></div>
    <div class="quick">
      <a class="btn primary" href="#/blog/new">${icon('plus')}New blog post</a>
      <a class="btn" href="#/home">Edit homepage</a>
      <a class="btn" href="#/photos">Arrange photos</a>
      <a class="btn" href="#/projects/new">${icon('plus')}Add project</a>
      <a class="btn" href="#/apps">Apps &amp; deploys</a>
    </div>
    <div class="ov">
      <section class="card c-home"><h2><span class="n">01</span>On the homepage now<a class="aside" href="#/home">Edit →</a></h2>
        ${m ? `<div class="feature"><div class="thumb" style="background-image:${cssUrl(m.thumbnail)}"></div>
          <div><div class="kicker">Main post · ${esc(prettyDate(m.date))}</div><h3>${esc(m.title)}</h3><p>${esc(m.excerpt)}</p>
          <div class="row" style="margin-top:14px"><a class="btn sm" href="#/home">Change main post</a>${m.link ? `<a class="btn sm ghost" href="${esc(m.link)}" target="_blank" rel="noopener">Open ${icon('ext')}</a>` : ''}</div></div></div>
          <div class="kicker" style="margin-top:22px">Featured</div>
          <div class="feats">${(h.featured || []).map((f) => `<a href="#/home"><i style="background-image:${cssUrl(f && f.thumbnail)}"></i><span>${esc((f && f.title) || 'Empty slot')}</span></a>`).join('')}</div>`
          : `<div class="banner warn">Homepage data unavailable.</div>`}
      </section>
      <section class="card c-health"><h2><span class="n">02</span>Apps<a class="aside" href="#/apps">All →</a></h2>
        ${reg.ok ? `<div class="big">${apps.length}<small> apps</small></div>
          <p class="sub" style="margin-top:8px">${failing.length ? `<b style="color:var(--bad)">${failing.length} with a failed last operation</b>` : 'No failed last operations.'}${ops.ok ? '' : ' Argus history unavailable.'}</p>
          <div class="apps">${apps.map((a) => { const o = latest.get(a.application); return `<a class="chip" href="#/apps/${encodeURIComponent(a.application)}" title="${esc(o ? `${o.operation}: ${o.status}, ${ago(o.createdAt)}` : 'no operations yet')}"><span class="dot ${dotFor(o && o.status)}"></span>${esc(a.application)}</a>`; }).join('')}</div>`
          : '<div class="banner bad">Registry unavailable.</div>'}
      </section>
      <section class="card c-stats tint-pink"><h2><span class="n">03</span>Content</h2><div class="stats">
        <a href="#/blog"><b>${postCount ?? '—'}</b><span>blog posts${catCount != null ? ` · ${catCount} categories` : ''}</span></a>
        <a href="#/minis"><b>${minis.ok ? minis.v.data.length : '—'}</b><span>minis</span></a>
        <a href="#/projects"><b>${projects.ok ? projects.v.data.length : '—'}</b><span>projects</span></a>
        <a href="#/photos"><b>${photos.ok ? imgCount : '—'}</b><span>photos · ${series.length} series</span></a></div></section>
      <section class="card c-act"><h2><span class="n">04</span>Recent activity<a class="aside" href="#/data">Data →</a></h2>
        ${activity.length ? `<ul class="act">${activity.map((a) => `<li><span>${a.html}</span><em>${esc(ago(a.at))}</em></li>`).join('')}</ul>` : '<div class="empty">Nothing yet.</div>'}</section>
      <section class="card c-photos"><h2><span class="n">05</span>Photos<a class="aside" href="#/photos">Arrange →</a></h2>
        <div class="kicker" style="margin-bottom:10px">${series.length} series · ${imgCount} images</div>
        <div class="mini-bento">${thumbs.map((t, i) => `<i style="background-image:${cssUrl(t)};${i === 0 ? 'grid-column:span 2;grid-row:span 2' : ''}"></i>`).join('')}</div></section>
    </div>`;
}
