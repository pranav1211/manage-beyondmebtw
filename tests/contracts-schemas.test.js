import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  validateOperationRequest,
  validateOperationRecord,
  validateArgusEvent,
  validatePm2AppConfig,
  validateNginxManifest,
  validateConfigRepoManifest,
  validateVersioned,
  SCHEMA_VERSION
} from '../shared/schemas/index.js';
import { makeOperationRequest, CONTRACT_SCHEMA_VERSION } from '../shared/contracts/manage-argus.js';

function fixture(name) {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'));
}

test('operation request: valid fixture passes, built request passes', () => {
  assert.equal(validateOperationRequest(fixture('operation-request.valid.json')).valid, true);
  const built = makeOperationRequest('build', 'beyondmebtw');
  assert.equal(built.schemaVersion, CONTRACT_SCHEMA_VERSION);
  assert.equal(validateOperationRequest(built).valid, true);
});

test('operation request: unknown operation rejected', () => {
  const bad = { schemaVersion: 1, operation: 'rm -rf', application: 'x' };
  assert.equal(validateOperationRequest(bad).valid, false);
});

test('operation request: unknown key rejected (additionalProperties false)', () => {
  const bad = { schemaVersion: 1, operation: 'deploy', application: 'x', secret: 'nope' };
  assert.equal(validateOperationRequest(bad).valid, false);
});

test('operation record + argus event validate', () => {
  const rec = {
    schemaVersion: 1,
    operationId: 'op_123',
    operation: 'deploy',
    application: 'minis',
    status: 'running',
    stage: 'sync',
    createdAt: '2026-11-13T00:00:00Z'
  };
  assert.equal(validateOperationRecord(rec).valid, true);
  const evt = { schemaVersion: 1, operationId: 'op_123', status: 'succeeded', stage: 'health-check' };
  assert.equal(validateArgusEvent(evt).valid, true);
});

test('pm2 app config: valid; secret VALUES are not part of the shape', () => {
  const cfg = fixture('pm2-app-config.valid.json');
  assert.equal(validatePm2AppConfig(cfg).valid, true);
  // envRefs are names only; a value-bearing env object must be rejected.
  const bad = structuredClone(cfg);
  bad.processes[0].env = { MANAGE_SESSION_SECRET: 'leaked' };
  assert.equal(validatePm2AppConfig(bad).valid, false);
});

test('nginx manifest: valid; bad conf filename rejected', () => {
  assert.equal(validateNginxManifest(fixture('nginx-manifest.valid.json')).valid, true);
  const bad = fixture('nginx-manifest.valid.json');
  bad.sites[0].confFile = 'manage.txt';
  assert.equal(validateNginxManifest(bad).valid, false);
});

test('config repo manifest: valid fixture passes', () => {
  assert.equal(validateConfigRepoManifest(fixture('config-repo-manifest.valid.json')).valid, true);
});

test('unsupported schemaVersion is rejected by validateVersioned', () => {
  const r = validateVersioned('configRepoManifest', fixture('config-repo-manifest.bad-version.json'));
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.keyword === 'version'));
  assert.equal(SCHEMA_VERSION, 1);
});
