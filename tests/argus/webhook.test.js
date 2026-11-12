import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWebhook, sign, verifySignature } from '../../services/argus/webhook.js';
import { loadRegistry } from '../../services/argus/registry.js';
import { tmp, registryEntry, writeRegistry, signedPush } from '../helpers/argus-fixtures.js';

const SHA = 'a'.repeat(40);
const registry = loadRegistry(
  writeRegistry(tmp('reg-'), [
    registryEntry('node-ok', { secretRef: 'ARGUS_WEBHOOK_SECRET_NODE_OK' }),
    registryEntry('plain-app'),
    registryEntry('off-app', { enabled: false })
  ])
);
const env = { ARGUS_WEBHOOK_SECRET_NODE_OK: 'custom-secret', WEBHOOK_DEFAULT_SECRET: 'default-secret' };

function req(fullName, secret, extra = {}) {
  const { body, sig } = signedPush({ fullName, after: SHA, secret, ...extra });
  return { headers: { 'x-github-event': 'push', 'x-hub-signature-256': sig }, rawBody: body, registry, env };
}

const codeOf = (fn) => { try { fn(); return null; } catch (e) { return e.code; } };

test('valid custom-secret signature is accepted', () => {
  const r = parseWebhook(req('fixture/node-ok', 'custom-secret'));
  assert.deepEqual(r, { kind: 'deploy', application: 'node-ok', commit: SHA, ref: 'refs/heads/main' });
});

test('default secret policy applies when no custom ref', () => {
  assert.equal(parseWebhook(req('fixture/plain-app', 'default-secret')).kind, 'deploy');
  // the default secret must NOT unlock an app with a custom secret
  assert.equal(codeOf(() => parseWebhook(req('fixture/node-ok', 'default-secret'))), 'SIGNATURE_INVALID');
});

test('invalid and missing signatures are rejected', () => {
  assert.equal(codeOf(() => parseWebhook(req('fixture/node-ok', 'wrong'))), 'SIGNATURE_INVALID');
  const r = req('fixture/node-ok', 'custom-secret');
  delete r.headers['x-hub-signature-256'];
  assert.equal(codeOf(() => parseWebhook(r)), 'SIGNATURE_INVALID');
});

test('unset secret fails closed', () => {
  const r = req('fixture/plain-app', 'default-secret');
  r.env = {};
  assert.equal(codeOf(() => parseWebhook(r)), 'SIGNATURE_INVALID');
});

test('unknown repository and disabled target are rejected', () => {
  assert.equal(codeOf(() => parseWebhook(req('someone/else', 'default-secret'))), 'UNKNOWN_TARGET');
  assert.equal(codeOf(() => parseWebhook(req('fixture/off-app', 'default-secret'))), 'TARGET_DISABLED');
});

test('wrong branch is a recorded no-op, not a deploy', () => {
  const r = parseWebhook(req('fixture/node-ok', 'custom-secret', { ref: 'refs/heads/feature' }));
  assert.equal(r.kind, 'noop');
  assert.equal(r.reason, 'branch-not-tracked');
});

test('malformed payloads and unsupported events are rejected', () => {
  const base = req('fixture/node-ok', 'custom-secret');
  assert.equal(codeOf(() => parseWebhook({ ...base, rawBody: Buffer.from('{not json') })), 'VALIDATION_FAILED');
  assert.equal(codeOf(() => parseWebhook({ ...base, headers: { ...base.headers, 'x-github-event': undefined } })), 'VALIDATION_FAILED');
  const bad = Buffer.from(JSON.stringify({ ref: 'refs/heads/main', after: 'nope', repository: { full_name: 'fixture/node-ok' } }));
  assert.equal(
    codeOf(() => parseWebhook({ ...base, rawBody: bad, headers: { ...base.headers, 'x-hub-signature-256': sign(bad, 'custom-secret') } })),
    'VALIDATION_FAILED'
  );
  const issue = { ...base, headers: { ...base.headers, 'x-github-event': 'issues' } };
  assert.equal(codeOf(() => parseWebhook(issue)), 'VALIDATION_FAILED');
});

test('signature comparison is length-safe', () => {
  const body = Buffer.from('{}');
  assert.equal(verifySignature(body, 'sha256=abc', 'k'), false);
  assert.equal(verifySignature(body, sign(body, 'k'), 'k'), true);
});
