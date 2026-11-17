// Server-owned, derived fields of `home.latest`, recomputed from scratch from the full source data
// (blog.categories + every blog.posts.<category> + home.latest itself) whenever any of them change:
//
//   recent[]                      the newest posts across all categories (newest first, ≤ RECENT_KEEP),
//                                 excluding the hand-picked mainPost and featured posts
//   mainPost / featured[i]:       category + categoryName, when the card's link matches a post
//     category, categoryName
//   recentGeneratedAt             when the derived content last changed (debugging aid)
//
// Consumer: Beyondmebtw/script.js (pickRecent and the boot block). Matching uses the same link
// normalisation as the site's linkKey(): lower-case, no ?query / #hash, no trailing slashes.

export const RECENT_KEEP = 6; // the page shows 4 and re-applies the exclusion itself; 2 are slack
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DERIVED_CARD_FIELDS = ['category', 'categoryName'];

export const linkKey = (u) => String(u ?? '').trim().toLowerCase().replace(/[?#].*$/, '').replace(/\/+$/, '');

/** "2026-11-07" or "Jan 18, 2025" (also "January 18 2025") -> { iso: "YYYY-MM-DD", t }, or null if unparseable. */
export function parsePostDate(raw) {
  const s = String(raw ?? '').trim();
  let y, m, d;
  let x = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:$|[T\s])/.exec(s);
  if (x) [y, m, d] = [Number(x[1]), Number(x[2]), Number(x[3])];
  else if ((x = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s))) {
    m = MONTHS[x[1].slice(0, 3).toLowerCase()];
    [d, y] = [Number(x[2]), Number(x[3])];
  } else return null;
  if (!m || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  if (back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null; // e.g. Feb 31
  return { iso: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, t };
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** home.latest without any derived fields (what a human or app actually chose). */
export function stripDerived(home) {
  const h = JSON.parse(JSON.stringify(home));
  delete h.recent;
  delete h.recentGeneratedAt;
  const clean = (c) => { if (isObj(c)) for (const f of DERIVED_CARD_FIELDS) delete c[f]; };
  clean(h.mainPost);
  if (Array.isArray(h.featured)) h.featured.forEach(clean);
  return h;
}

/**
 * @param {object} home        the home.latest document (derived fields, if any, are recomputed)
 * @param {object} categories  the blog.categories manifest ({ key: { name, … } }, in display order)
 * @param {Record<string, object|null>} postsByKey  blog.posts.<key> documents ({ posts: [...] }), by category key
 * @param {{ now?: Date, previous?: object }} [opts] previous = current stored home.latest, to keep its
 *        recentGeneratedAt when nothing derived actually changed (so a recompute can be a true no-op)
 */
export function deriveHome(home, categories, postsByKey, { now = new Date(), previous = null } = {}) {
  const out = stripDerived(home);
  const cats = isObj(categories) ? categories : {};
  const nameOf = (k) => (isObj(cats[k]) && typeof cats[k].name === 'string' && cats[k].name ? cats[k].name : k);

  // Every post, in manifest order then list order (that order is the deterministic tie-break).
  const all = [];
  for (const key of Object.keys(cats)) {
    const doc = postsByKey[key];
    const posts = doc && Array.isArray(doc.posts) ? doc.posts : [];
    posts.forEach((p) => { if (isObj(p)) all.push({ p, key, order: all.length }); });
  }
  const byLink = new Map();
  for (const it of all) { const k = linkKey(it.p.link); if (k && !byLink.has(k)) byLink.set(k, it); }

  const annotate = (card) => {
    if (!isObj(card)) return;
    const hit = byLink.get(linkKey(card.link));
    if (hit) { card.category = hit.key; card.categoryName = nameOf(hit.key); }
  };
  annotate(out.mainPost);
  if (Array.isArray(out.featured)) out.featured.forEach(annotate);

  const excluded = new Set([out.mainPost, ...(Array.isArray(out.featured) ? out.featured : [])].filter(isObj).map((c) => linkKey(c.link)).filter(Boolean));
  const str = (v) => (typeof v === 'string' ? v : '');
  out.recent = all
    .map((it) => ({ ...it, date: parsePostDate(it.p.date) }))
    .filter((it) => it.date && !excluded.has(linkKey(it.p.link)))
    .sort((a, b) => b.date.t - a.date.t || a.order - b.order)
    .slice(0, RECENT_KEEP)
    .map(({ p, key, date }) => {
      const r = { uid: str(p.uid), title: str(p.title), date: date.iso, excerpt: str(p.excerpt), thumbnail: str(p.thumbnail), link: str(p.link), category: key, categoryName: nameOf(key) };
      if (str(p.subcategory)) r.subcategory = p.subcategory;
      return r;
    });

  // Only move the timestamp when the derived content really changed.
  const prev = isObj(previous) ? previous : null;
  const sameAsPrev = prev && prev.recentGeneratedAt && JSON.stringify({ ...prev, recentGeneratedAt: 0 }) === JSON.stringify({ ...out, recentGeneratedAt: 0 });
  out.recentGeneratedAt = sameAsPrev ? prev.recentGeneratedAt : now.toISOString();
  return out;
}

/** Keys whose change can change the derived fields. */
export const affectsHome = (key) => key === 'home.latest' || key === 'blog.categories' || /^blog\.posts\.[^.]+$/.test(key);
