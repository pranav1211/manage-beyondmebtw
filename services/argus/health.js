// Deployment health checks — binary SUCCESS/FAILURE, HTTP 200 required.
// Static: GET <base>/index.html. Node: GET http://127.0.0.1:<port><healthPath>.
// A failure stops the operation; there is no rollback.

import { AppError } from '../../shared/errors.js';

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function checkHttp(url, { attempts = 10, intervalMs = 500, timeoutMs = 3000 } = {}) {
  let last = { status: null, error: null };
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
      last = { status: res.status, error: null };
      await res.arrayBuffer().catch(() => {});
      if (res.status === 200) return { ok: true, url, status: 200, attempts: i };
    } catch (err) {
      last = { status: null, error: err.name === 'TimeoutError' ? 'timeout' : 'connection-failed' };
    }
    if (i < attempts) await sleep(intervalMs);
  }
  return { ok: false, url, status: last.status, error: last.error, attempts };
}

export function nodeHealthUrl(port, healthPath) {
  return `http://127.0.0.1:${port}${healthPath}`;
}

export async function assertHealthy(url, opts) {
  const result = await checkHttp(url, opts);
  if (!result.ok) {
    throw new AppError('HEALTH_CHECK_FAILED', 'Health check did not return HTTP 200', {
      url: result.url,
      status: result.status,
      error: result.error,
      attempts: result.attempts
    });
  }
  return result;
}
