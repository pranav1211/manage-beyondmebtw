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

async function call(method, path, body) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;
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
  registry: () => call('GET', '/registry'),
  app: (name) => call('GET', `/registry/${encodeURIComponent(name)}`),
  createApp: (entry) => call('POST', '/registry', entry),
  updateApp: (name, entry) => call('PUT', `/registry/${encodeURIComponent(name)}`, entry),
  setEnabled: (name, enabled) => call('PATCH', `/registry/${encodeURIComponent(name)}/enabled`, { enabled }),
  retryPush: () => call('POST', '/registry/retry-push', {}),
  operations: (application, limit = 50) =>
    call('GET', `/operations?limit=${limit}${application ? `&application=${encodeURIComponent(application)}` : ''}`),
  operation: (id) => call('GET', `/operations/${encodeURIComponent(id)}`),
  submit: (operation, application, params) =>
    call('POST', '/operations', { operation, application, ...(params ? { params } : {}) }),
  reconcileApp: (name) => call('POST', `/reconcile/${encodeURIComponent(name)}`, {}),
  reconcileAll: (confirm) => call('POST', '/reconcile', { confirm }),
  dataStatus: () => call('GET', '/data/status'),
  dataResources: () => call('GET', '/data/resources'),
  dataOperations: (limit = 30) => call('GET', `/data/operations?limit=${limit}`),
  dataRetry: (id) => call('POST', `/data/operations/${encodeURIComponent(id)}/retry`, {}),
  dataCompare: (key) => call('GET', `/data/resources/${encodeURIComponent(key)}/compare`),
  dataResource: (key) => call('GET', `/data/resources/${encodeURIComponent(key)}`),
  dataReplace: (key, data, ifRevision) => call('PUT', `/data/resources/${encodeURIComponent(key)}`, { data, ifRevision }),
  appEnv: (app) => call('GET', `/apps/${encodeURIComponent(app)}/env`),
  setAppEnv: (app, body) => call('PUT', `/apps/${encodeURIComponent(app)}/env`, body),
  appToken: (app) => call('GET', `/apps/${encodeURIComponent(app)}/token`),
  issueAppToken: (app, body) => call('POST', `/apps/${encodeURIComponent(app)}/token`, body),
  revokeAppToken: (app) => call('DELETE', `/apps/${encodeURIComponent(app)}/token?restart=true`)
};
