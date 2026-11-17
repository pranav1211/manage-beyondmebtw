// Thin client for the Manage API (/api/v1). The browser talks to Manage only —
// there is deliberately no Argus address or token anywhere in the frontend.

let csrfToken = null;

export class ApiError extends Error {
  constructor(status, body) {
    super((body && body.message) || `HTTP ${status}`);
    this.status = status;
    this.code = (body && body.code) || 'HTTP_ERROR';
    this.details = body && body.details;
  }
}

const idem = () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2)}`);

// Activity signals for the UI (top progress bar, "saving…" status). Events, so api.js has no UI imports.
let inFlight = 0;
const emit = (name, detail) => { try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch { /* non-browser */ } };

async function call(method, path, body, opts = {}) {
  const write = method !== 'GET';
  inFlight += 1;
  emit('manage:net', inFlight);
  if (write) emit('manage:write', 'start');
  try {
    return await request(method, path, body, opts);
  } finally {
    inFlight -= 1;
    emit('manage:net', inFlight);
    if (write) emit('manage:write', 'end');
  }
}

async function request(method, path, body, { idempotent = false } = {}) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;
  // Data writes carry an idempotency key, so a retried request can never apply twice.
  if (idempotent) headers['idempotency-key'] = idem();
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) throw new ApiError(res.status, json);
  return json;
}

const R = (key) => `/data/resources/${encodeURIComponent(key)}`;
const W = { idempotent: true };

export const api = {
  async session() {
    const s = await call('GET', '/auth/session');
    csrfToken = s.authenticated ? s.csrfToken : null;
    return s;
  },
  async login(password) {
    const s = await call('POST', '/auth/login', { password });
    csrfToken = s.csrfToken;
    return s;
  },
  async logout() {
    await call('POST', '/auth/logout', {});
    csrfToken = null;
  },
  status: () => call('GET', '/status'),

  // ── registry / applications ──
  registry: () => call('GET', '/registry'),
  app: (name) => call('GET', `/registry/${encodeURIComponent(name)}`),
  createApp: (entry) => call('POST', '/registry', entry),
  updateApp: (name, entry) => call('PUT', `/registry/${encodeURIComponent(name)}`, entry),
  setEnabled: (name, enabled) => call('PATCH', `/registry/${encodeURIComponent(name)}/enabled`, { enabled }),
  setAutoDeploy: (name, autoDeploy) => call('PATCH', `/registry/${encodeURIComponent(name)}/auto-deploy`, { autoDeploy }),
  retryPush: () => call('POST', '/registry/retry-push', {}),
  operations: (application, limit = 50) =>
    call('GET', `/operations?limit=${limit}${application ? `&application=${encodeURIComponent(application)}` : ''}`),
  operation: (id) => call('GET', `/operations/${encodeURIComponent(id)}`),
  submit: (operation, application, params) =>
    call('POST', '/operations', { operation, application, ...(params ? { params } : {}) }),
  reconcileApp: (name) => call('POST', `/reconcile/${encodeURIComponent(name)}`, {}),
  reconcileAll: (confirm) => call('POST', '/reconcile', { confirm }),
  appEnv: (app) => call('GET', `/apps/${encodeURIComponent(app)}/env`),
  setAppEnv: (app, body) => call('PUT', `/apps/${encodeURIComponent(app)}/env`, body),
  appToken: (app) => call('GET', `/apps/${encodeURIComponent(app)}/token`),
  issueAppToken: (app, body) => call('POST', `/apps/${encodeURIComponent(app)}/token`, body),
  revokeAppToken: (app) => call('DELETE', `/apps/${encodeURIComponent(app)}/token?restart=true`),

  // ── canonical data (bmb-data) ──
  dataStatus: () => call('GET', '/data/status'),
  dataResources: () => call('GET', '/data/resources'),
  dataOperations: (limit = 30) => call('GET', `/data/operations?limit=${limit}`),
  dataRetry: (id) => call('POST', `/data/operations/${encodeURIComponent(id)}/retry`, {}),
  read: (key) => call('GET', R(key)),
  replace: (key, data, ifRevision) => call('PUT', R(key), { data, ifRevision }, W),
  createItem: (key, item, ifRevision) => call('POST', `${R(key)}/items`, { item, ifRevision }, W),
  updateItem: (key, id, item, ifRevision) => call('PUT', `${R(key)}/items/${encodeURIComponent(id)}`, { item, ifRevision }, W),
  deleteItem: (key, id, ifRevision) => call('DELETE', `${R(key)}/items/${encodeURIComponent(id)}`, { ifRevision }, W),
  // changes: [{ key, data, ifRevision } | { key, delete: true, ifRevision }] — one commit, all or nothing.
  transaction: (changes) => call('POST', '/data/transactions', { changes }, W),
  // Admin: add a dataset (catalog entry + a document's first content), one commit.
  createDataset: (spec) => call('POST', '/data/catalog', spec, W)
};
