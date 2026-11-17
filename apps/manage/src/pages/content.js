// Loaders for the site's canonical content (bmb-data via the Manage data API).
// Every loader returns the document AND its revision; writes send the revision back
// (ifRevision) so a stale page can never overwrite newer data.

import { api, ApiError } from '../api.js';

export async function loadBlog() {
  const cats = await api.read('blog.categories');
  const keys = Object.keys(cats.data);
  const docs = await Promise.all(
    keys.map((k) =>
      api.read(`blog.posts.${k}`).catch((err) => {
        if (err instanceof ApiError && err.code === 'RESOURCE_NOT_FOUND') return { data: { subcategories: [], posts: [] }, revision: null, missing: true };
        throw err;
      })
    )
  );
  const posts = {};
  keys.forEach((k, i) => { posts[k] = docs[i]; });
  return { categories: cats.data, categoriesRevision: cats.revision, posts };
}

export const loadHome = () => api.read('home.latest');
export const loadProjects = () => api.read('projects');
export const loadPhotos = () => api.read('photos');
export const loadMinis = () => api.read('minis.metadata');

/** Every post across categories, newest first, with its category key attached. */
export function allPosts(blog) {
  const out = [];
  for (const [cat, doc] of Object.entries(blog.posts)) for (const p of doc.data.posts || []) out.push({ ...p, category: cat });
  return out.sort((a, b) => (new Date(b.date).getTime() || 0) - (new Date(a.date).getTime() || 0));
}

/** The homepage card fields for a post (what home.latest.mainPost / featured[] hold). */
export const homeCard = (p) => ({ title: p.title || '', date: p.date || '', excerpt: p.excerpt || '', thumbnail: p.thumbnail || '', link: p.link || '' });

/** Where a post appears on the homepage: 'main', 'featured N', or null (matched by link). */
export function homePlacement(home, post) {
  if (!home || !post || !post.link) return null;
  if (home.mainPost && home.mainPost.link === post.link) return 'main';
  const i = (home.featured || []).findIndex((f) => f && f.link === post.link);
  return i > -1 ? `featured ${i + 1}` : null;
}
