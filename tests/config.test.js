import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../shared/config/index.js';

test('loads non-secret defaults in local mode', () => {
  const cfg = loadConfig({ env: {} });
  assert.equal(cfg.nodeEnv, 'development');
  assert.equal(cfg.manageApiPort, 7100);
  assert.equal(cfg.argusPort, 6040);
  assert.equal(cfg.argusBind, '127.0.0.1');
  assert.equal(cfg.isProd, false);
  assert.equal(cfg.hasSessionSecret, false);
});

test('missing required secrets throw CONFIG_MISSING when enforced', () => {
  try {
    loadConfig({ env: {}, requireSecrets: true });
    assert.fail('expected throw');
  } catch (err) {
    assert.equal(err.code, 'CONFIG_MISSING');
    assert.deepEqual(err.details.missing, ['MANAGE_SESSION_SECRET', 'ARGUS_INTERNAL_TOKEN']);
    // The error must not echo any secret VALUE.
    assert.ok(!/replace-me/.test(err.message));
  }
});

test('present secrets satisfy enforcement', () => {
  const cfg = loadConfig({
    env: {
      MANAGE_SESSION_SECRET: 'x',
      ARGUS_INTERNAL_TOKEN: 'y'
    },
    requireSecrets: true
  });
  assert.equal(cfg.hasSessionSecret, true);
  assert.equal(cfg.hasArgusToken, true);
});

test('production enforces secrets implicitly', () => {
  assert.throws(
    () => loadConfig({ env: { NODE_ENV: 'production' } }),
    (e) => e.code === 'CONFIG_MISSING'
  );
});

test('non-localhost ARGUS_BIND is rejected', () => {
  assert.throws(
    () => loadConfig({ env: { ARGUS_BIND: '0.0.0.0' } }),
    (e) => e.code === 'CONFIG_INVALID' && e.details.name === 'ARGUS_BIND'
  );
});

test('invalid port is rejected', () => {
  assert.throws(
    () => loadConfig({ env: { MANAGE_API_PORT: '70000' } }),
    (e) => e.code === 'CONFIG_INVALID'
  );
});
