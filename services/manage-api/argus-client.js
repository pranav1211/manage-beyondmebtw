// Server-side Manage -> Argus client. Loopback only, bearer-token auth, schema
// validation on the way out AND on the way back, bounded timeouts. Neither the
// token nor Argus's address is ever sent to the browser.

import { AppError, ERROR_CODES } from '../../shared/errors.js';
import { validateOperationRequest, validateOperationRecord } from '../../shared/schemas/index.js';
import { makeOperationRequest } from '../../shared/contracts/manage-argus.js';

function upstreamError(code, message, httpStatus) {
  const err = new AppError(ERROR_CODES[code] ? code : 'ARGUS_BAD_RESPONSE', message);
  err.httpStatus = httpStatus;
  return err;
}

export function createArgusClient({ baseUrl, token, timeoutMs = 5000, fetchImpl = fetch }) {
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(String(baseUrl))) {
    throw new AppError('CONFIG_INVALID', 'Argus URL must be a loopback address');
  }

  async function request(method, path, body) {
    let res;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'content-type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (err) {
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw upstreamError('ARGUS_TIMEOUT', 'Argus did not respond in time', 504);
      }
      throw upstreamError('ARGUS_UNAVAILABLE', 'Argus is not reachable', 502);
    }
    let json;
    try {
      json = await res.json();
    } catch {
      throw upstreamError('ARGUS_BAD_RESPONSE', 'Argus returned a non-JSON response', 502);
    }
    if (res.status === 401) throw upstreamError('ARGUS_UNAUTHORIZED', 'Manage is not authorized to call Argus', 502);
    if (!res.ok) {
      // Pass Argus's stable, sanitized code through (e.g. TARGET_NOT_ALLOWED).
      throw upstreamError(json && json.code, (json && json.message) || 'Argus rejected the request', res.status);
    }
    return json;
  }

  return Object.freeze({
    async health() {
      const h = await request('GET', '/health');
      if (!h || h.service !== 'argus') throw upstreamError('ARGUS_BAD_RESPONSE', 'Unexpected Argus health response', 502);
      // /health is public on loopback, so it can't prove Manage may act.
      // Probe an authenticated route: a token mismatch must not look healthy.
      try {
        await request('GET', '/operations?limit=1');
      } catch (err) {
        // 501 = authenticated, but execution disabled in this Argus config.
        if (err.httpStatus !== 501) throw err;
      }
      return { reachable: true, authenticated: true, mode: h.mode, executionEnabled: Boolean(h.executionEnabled) };
    },

    async submit(operation, application, params) {
      const req = makeOperationRequest(operation, application, params && Object.keys(params).length ? params : undefined);
      const { valid, errors } = validateOperationRequest(req);
      if (!valid) {
        const err = new AppError('VALIDATION_FAILED', 'Invalid operation request', { errors });
        err.httpStatus = 400;
        throw err;
      }
      const out = await request('POST', '/operations', req);
      if (!out || typeof out.operationId !== 'string' || !/^op_/.test(out.operationId)) {
        throw upstreamError('ARGUS_BAD_RESPONSE', 'Argus did not return an operation id', 502);
      }
      return { operationId: out.operationId, queued: Boolean(out.queued), superseded: out.superseded || null };
    },

    async getOperation(id) {
      if (!/^op_[a-z0-9]+_[0-9a-f]{8}$/.test(String(id))) {
        const err = new AppError('VALIDATION_FAILED', 'Invalid operation id');
        err.httpStatus = 400;
        throw err;
      }
      const rec = await request('GET', `/operations/${id}`);
      if (!validateOperationRecord(rec).valid) throw upstreamError('ARGUS_BAD_RESPONSE', 'Malformed operation record from Argus', 502);
      return rec;
    },

    async listOperations({ application, limit } = {}) {
      const q = new URLSearchParams();
      if (application) q.set('application', application);
      if (limit) q.set('limit', String(limit));
      const out = await request('GET', `/operations${q.size ? `?${q}` : ''}`);
      if (!out || !Array.isArray(out.operations) || !out.operations.every((r) => validateOperationRecord(r).valid)) {
        throw upstreamError('ARGUS_BAD_RESPONSE', 'Malformed operation list from Argus', 502);
      }
      return out;
    },

    async appStatus(application) {
      return request('GET', `/apps/${encodeURIComponent(application)}/status`);
    }
  });
}
