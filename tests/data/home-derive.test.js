// home.latest derived fields: recent[] + categoryName on mainPost/featured, recomputed from scratch,
// in the same commit as the triggering change, never re-triggering themselves.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveHome, parsePostDate, linkKey } from '../../shared/data/home-derive.js';
import { createResourceStore } from '../../services/manage-api/resource-store.js';
import { makeSeededDataRepo, openRepo, commitCount, seedFiles, j } from '../helpers/data-fixtures.js';
import { git } from '../helpers/argus-fixtures.js';

const CATS = { f1: { name: 'Formula 1', subcategories: ['2026 Season'] }, movies: { name: 'Movies & TV', subcategories: [] } };
const P = (uid, date, link, extra = {}) => ({ uid, title: `T ${uid}`, date, excerpt: `E ${uid}`, thumbnail: `https://img/${uid}.webp`, link, ...extra });
const F1 = { subcategories: ['2026 Season'], posts: [P('f1_a', 'Jan 18, 2025', 'https://m.com/a'), P('f1_b', '2026-11-07', 'https://m.com/b', { subcategory: '2026 Season' }), P('f1_bad', 'someday', 'https://m.com/bad'), P('f1_g', '2026-02-01', 'https://m.com/g')] };
const MOVIES = { subcategories: [], posts: [P('mv_c', '2026-10-26', 'https://m.com/c'), P('mv_d', 'Mar 1, 2025', 'https://m.com/d'), P('mv_e', '2026-11-07', 'https://m.com/e'), P('mv_h', '2026-05-05', 'https://m.com/h'), P('mv_i', '2024-12-31', 'https://m.com/i')] };
const HOME = { mainPost: { title: 'C', link: 'https://M.com/c/' }, featured: [{ title: 'B', link: 'https://m.com/b?ref=x#top' }, {}, { title: 'External', link: 'https://elsewhere.example/x' }, {}], featuredProjects: [], featuredMinis: [], categories: {} };

test('derive: mixed date formats sort newest first, bad dates skipped, picked posts excluded by normalised link, ≤ 6', () => {
  assert.deepEqual(parsePostDate('Jan 18, 2025'), { iso: '2025-01-18', t: Date.UTC(2025, 0, 18) });
  assert.equal(parsePostDate('2026-02-31'), null);
  assert.equal(parsePostDate('someday'), null);
  assert.equal(linkKey('https://M.com/c/?a=1#x'), 'https://m.com/c');
  const out = deriveHome(HOME, CATS, { f1: F1, movies: MOVIES }, { now: new Date('2026-11-18T00:00:00Z') });
  const uids = out.recent.map((r) => r.uid);
  assert.deepEqual(uids, ['mv_e', 'mv_h', 'f1_g', 'mv_d', 'f1_a', 'mv_i'], 'b and c are on the page; f1_bad has no date');
  assert.equal(out.recent.find((r) => r.uid === 'mv_d').date, '2025-03-01', 'dates normalised to YYYY-MM-DD');
  assert.deepEqual(Object.keys(out.recent[0]), ['uid', 'title', 'date', 'excerpt', 'thumbnail', 'link', 'category', 'categoryName']);
  assert.equal(out.mainPost.categoryName, 'Movies & TV');
  assert.equal(out.featured[0].category, 'f1');
  assert.equal(out.featured[0].categoryName, 'Formula 1');
  assert.ok(!('categoryName' in out.featured[2]), 'an external link gets no category fields (not null, not "")');
  assert.deepEqual(out.featured[1], {}, 'empty slots stay empty');
  // ties: same date -> source order (f1 before movies in the manifest)
  const tie = deriveHome({ ...HOME, mainPost: {}, featured: [] }, CATS, { f1: F1, movies: MOVIES });
  assert.deepEqual(tie.recent.slice(0, 2).map((r) => r.uid), ['f1_b', 'mv_e']);
  // no-op: deriving again from the stored result keeps the timestamp
  const again = deriveHome(out, CATS, { f1: F1, movies: MOVIES }, { now: new Date('2030-01-01T00:00:00Z'), previous: out });
  assert.equal(JSON.stringify(again), JSON.stringify(out));
});

const CATALOG = {
  schemaVersion: 1,
  resources: [
    { key: 'blog.categories', root: 'data', path: 'blog/categories.json', format: 'json', access: 'public', status: 'imported', operations: ['read', 'replace'] },
    { key: 'blog.posts', root: 'data', path: 'blog/{id}.json', format: 'json', access: 'public', status: 'imported', collection: { idPattern: '^(?!categories$)[a-z0-9]{2,40}$' }, operations: ['read', 'replace', 'create', 'delete', 'create-item', 'update-item', 'delete-item'], items: { pointer: '/posts', idField: 'uid' } },
    { key: 'home.latest', root: 'data', path: 'home/latest.json', format: 'json', access: 'public', status: 'imported', operations: ['read', 'replace'] }
  ]
};

function seeded() {
  const files = { ...seedFiles(CATALOG), 'data/blog/categories.json': j(CATS), 'data/blog/f1.json': j(F1), 'data/blog/movies.json': j(MOVIES), 'data/home/latest.json': j(HOME) };
  const repo = makeSeededDataRepo(files);
  const resources = createResourceStore({ dataRepo: openRepo(repo) });
  const home = () => resources.read('home.latest', { kind: 'admin' }).data;
  const lastCommitFiles = () => git(repo.bare, ['show', '--name-only', '--format=', 'main']).split('\n').filter(Boolean).sort();
  return { repo, resources, home, lastCommitFiles };
}

test('writes: backfill once, then every post/category/home change carries the recomputed home.latest in the same commit', async () => {
  const { repo, resources, home, lastCommitFiles } = seeded();
  const c0 = commitCount(repo);
  assert.equal((await resources.refreshDerived()).status, 'succeeded', 'backfill');
  assert.equal(home().recent.length, 6);
  assert.equal((await resources.refreshDerived()).status, 'noop', 'nothing changed: no commit (the derived write does not re-trigger)');
  assert.equal(commitCount(repo), c0 + 1);

  // a new post: same commit as the post
  const f1 = resources.read('blog.posts.f1', { kind: 'admin' });
  await resources.createItem('blog.posts.f1', P('f1_new', '2026-11-17', 'https://m.com/new'), { ifRevision: f1.revision });
  assert.deepEqual(lastCommitFiles(), ['data/blog/f1.json', 'data/home/latest.json']);
  assert.equal(home().recent[0].uid, 'f1_new');

  // deleting it removes it from recent
  await resources.deleteItem('blog.posts.f1', 'f1_new');
  assert.ok(!home().recent.some((r) => r.uid === 'f1_new'));

  // featuring a recent post re-fills recent; client-sent derived fields are replaced
  const h = home();
  await resources.replace('home.latest', { ...h, featured: [h.featured[0], { title: 'H', link: 'https://m.com/h' }, h.featured[2], {}], recent: [{ title: '<b>forged</b>' }] });
  const after = home();
  assert.ok(!after.recent.some((r) => r.uid === 'mv_h' || r.title.includes('forged')));
  assert.equal(after.recent.length, 5, '8 dated posts minus main, featured b and the newly featured h');
  assert.equal(after.featured[1].categoryName, 'Movies & TV');

  // renaming a category updates categoryName everywhere (one transaction, one commit)
  const cats = resources.read('blog.categories', { kind: 'admin' });
  const before = commitCount(repo);
  await resources.transaction([{ key: 'blog.categories', data: { ...cats.data, f1: { ...cats.data.f1, name: 'F1' } }, ifRevision: cats.revision }]);
  assert.equal(commitCount(repo), before + 1);
  const renamed = home();
  assert.equal(renamed.featured[0].categoryName, 'F1');
  assert.ok(renamed.recent.filter((r) => r.category === 'f1').every((r) => r.categoryName === 'F1'));
  assert.equal((await resources.refreshDerived()).status, 'noop');
});
