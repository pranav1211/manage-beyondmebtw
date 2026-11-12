import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../shared/config/index.js';
import { createApp as createManageApp } from '../services/manage-api/index.js';
import { createApp as createArgusApp } from '../services/argus/argus.js';

const cfg = loadConfig({ env: {} });

// Start an app on an ephemeral port and return a base URL + closer.
function serve(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r))
      });
    });
  });
}

test('manage-api: /health is ok', async () => {
  const { base, close } = await serve(createManageApp(cfg));
  try {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.service, 'manage-api');
  } finally {
    await close();
  }
});

test('manage-api: v1 route scaffold returns 501 NOT_IMPLEMENTED', async () => {
  const { base, close } = await serve(createManageApp(cfg));
  try {
    const res = await fetch(`${base}/api/v1/home`);
    assert.equal(res.status, 501);
    const body = await res.json();
    assert.equal(body.code, 'NOT_IMPLEMENTED');
  } finally {
    await close();
  }
});

test('manage-api: unknown route returns 404', async () => {
  const { base, close } = await serve(createManageApp(cfg));
  try {
    const res = await fetch(`${base}/nope`);
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

test('argus: /health reports execution disabled', async () => {
  const { base, close } = await serve(createArgusApp(cfg));
  try {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.service, 'argus');
    assert.equal(body.executionEnabled, false);
  } finally {
    await close();
  }
});

test('argus: known operation is refused when execution is disabled (501, after auth)', async () => {
  const { base, close } = await serve(createArgusApp(cfg, { env: { ARGUS_INTERNAL_TOKEN: 't0ken' } }));
  try {
    const res = await fetch(`${base}/operations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer t0ken' },
      body: JSON.stringify({ schemaVersion: 1, operation: 'deploy', application: 'beyondmebtw' })
    });
    assert.equal(res.status, 501);
    const body = await res.json();
    assert.equal(body.code, 'NOT_IMPLEMENTED');
  } finally {
    await close();
  }
});

test('argus: unauthenticated requests are rejected (401) before anything else', async () => {
  const { base, close } = await serve(createArgusApp(cfg));
  try {
    const res = await fetch(`${base}/operations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 1, operation: 'deploy', application: 'beyondmebtw' })
    });
    assert.equal(res.status, 401);
  } finally {
    await close();
  }
});

test('argus: unknown/arbitrary operation is rejected (400)', async () => {
  const { base, close } = await serve(createArgusApp(cfg, { env: { ARGUS_INTERNAL_TOKEN: 't0ken' } }));
  try {
    const res = await fetch(`${base}/operations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer t0ken' },
      body: JSON.stringify({ schemaVersion: 1, operation: 'rm -rf /', application: 'x' })
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, 'VALIDATION_FAILED');
  } finally {
    await close();
  }
});
