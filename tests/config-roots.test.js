import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../shared/config/index.js';

test('path roots are exposed and distinct by default', () => {
  const cfg = loadConfig({ env: {} });
  assert.deepEqual(Object.keys(cfg.pathRoots).sort(), ['configRepo', 'content', 'data', 'logs']);
  assert.equal(cfg.configRepoRoot, '../bmb-infrastructure');
  // All four resolve to distinct locations.
  const resolved = new Set(Object.values(cfg.pathRoots));
  assert.equal(resolved.size, 4);
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
