import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../shared/config/index.js';

test('path roots are exposed and distinct by default', () => {
  const cfg = loadConfig({ env: {} });
  assert.deepEqual(Object.keys(cfg.pathRoots).sort(), ['configRepo', 'content', 'data', 'dataRepo', 'logs']);
  assert.equal(cfg.configRepoRoot, '../bmb-infrastructure');
  // All five resolve to distinct locations.
  const resolved = new Set(Object.values(cfg.pathRoots));
  assert.equal(resolved.size, 5);
});

test('overlapping path roots are rejected', () => {
  assert.throws(
    () => loadConfig({ env: { DATA_ROOT: './x', CONTENT_ROOT: './x' } }),
    (e) => e.code === 'CONFIG_INVALID'
  );
});

test('config repo root is configurable (never hardcoded)', () => {
  const cfg = loadConfig({ env: { CONFIG_REPO_ROOT: '/srv/infra' } });
  assert.equal(cfg.configRepoRoot, '/srv/infra');
});

test('production mode is explicit: needs an allowlist; then /projects is allowed', () => {
  const base = { ARGUS_EXECUTION_ENABLED: 'true', ARGUS_MODE: 'production', PROJECTS_ROOT: '/projects' };
  assert.throws(() => loadConfig({ env: base }), (e) => e.code === 'CONFIG_INVALID');
  const cfg = loadConfig({ env: { ...base, ARGUS_EXECUTION_ALLOWLIST: 'manage-beyondmebtw, other' } });
  assert.deepEqual(cfg.argus.executionAllowlist, ['manage-beyondmebtw', 'other']);
  assert.equal(cfg.argus.mode, 'production');
  assert.throws(() => loadConfig({ env: { ARGUS_MODE: 'yolo' } }), (e) => e.code === 'CONFIG_INVALID');
});

test('per-service secrets: argus needs only its token; manage also needs session + password hash', () => {
  assert.doesNotThrow(() => loadConfig({ service: 'argus', env: { NODE_ENV: 'production', ARGUS_INTERNAL_TOKEN: 't' } }));
  assert.throws(
    () => loadConfig({ service: 'manage', env: { NODE_ENV: 'production', ARGUS_INTERNAL_TOKEN: 't', MANAGE_SESSION_SECRET: 's' } }),
    (e) => e.code === 'CONFIG_MISSING' && e.details.missing.includes('MANAGE_ADMIN_PASSWORD_HASH')
  );
});
