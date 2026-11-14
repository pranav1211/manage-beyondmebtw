import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPm2Metadata, renderEcosystem, parseEcosystem, pm2FileName } from '../../services/argus/pm2-gen.js';
import { registryEntry, declarationFor } from '../helpers/argus-fixtures.js';

const entry = registryEntry('node-ok', { secretRef: 'ARGUS_WEBHOOK_SECRET_NODE_OK' });
const decl = declarationFor(entry, { script: 'server.js', port: 47101, healthPath: '/health', envRefs: ['APP_DB_TOKEN'] });

test('generation is deterministic and uses the deterministic filename', () => {
  const a = renderEcosystem(buildPm2Metadata(entry, decl));
  const b = renderEcosystem(buildPm2Metadata(entry, decl));
  assert.equal(a, b);
  assert.equal(pm2FileName('node-ok'), 'node-ok.config.js');
  assert.match(a, /"name": "node-ok"/);
  assert.match(a, /"cwd": "\/projects\/node-ok"/);
  assert.match(a, /"PORT": "47101"/);
});

test('secret VALUES never appear — env carried by name only', () => {
  const secretValue = 'super-secret-value-123';
  process.env.APP_DB_TOKEN = secretValue;
  try {
    const text = renderEcosystem(buildPm2Metadata(entry, decl));
    assert.ok(!text.includes(secretValue), 'generated file must not contain secret values');
    assert.ok(text.includes('APP_DB_TOKEN'), 'secret is referenced by name in argus-meta');
  } finally {
    delete process.env.APP_DB_TOKEN;
  }
});

test('parse round-trips and validates; hand edits are rejected', () => {
  const text = renderEcosystem(buildPm2Metadata(entry, decl));
  const { meta, ecosystem } = parseEcosystem(text);
  assert.equal(meta.application, 'node-ok');
  assert.equal(ecosystem.apps[0].env.PORT, '47101');
  const edited = text.replace('"PORT": "47101"', '"PORT": "9999"');
  assert.throws(() => parseEcosystem(edited), (e) => e.code === 'INVALID_MANIFEST');
});

test('static apps and missing runtime are rejected', () => {
  const s = registryEntry('static-ok', { type: 'static' });
  assert.throws(() => buildPm2Metadata(s, declarationFor(s)), (e) => e.code === 'VALIDATION_FAILED');
  assert.throws(() => buildPm2Metadata(entry, declarationFor(entry)), (e) => e.code === 'VALIDATION_FAILED');
});

test('envFile: generated config passes only the env-file PATH via node --env-file', () => {
  const d = declarationFor(entry, { script: 'server.js', port: 47101, healthPath: '/health', envFile: true });
  const text = renderEcosystem(buildPm2Metadata(entry, d));
  assert.match(text, /"--env-file=\/infrastructure\/env\/node-ok\.env"/);
  const { ecosystem } = parseEcosystem(text);
  assert.deepEqual(ecosystem.apps[0].node_args, ['--env-file=/infrastructure/env/node-ok.env']);
  assert.ok(!('MANAGE_SESSION_SECRET' in ecosystem.apps[0].env));
});
