import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertSafeIdentifier,
  assertSafeCatalogKey,
  assertAllowedExtension,
  assertKnownKeys,
  resolveWithinRoot,
  isWithinRoot,
  assertNotSecretOrRuntimePath
} from '../shared/validation/paths.js';

function codeOf(fn) {
  try {
    fn();
    return null;
  } catch (e) {
    return e.code;
  }
}

test('identifiers and keys', () => {
  assert.equal(assertSafeIdentifier('minis-private'), 'minis-private');
  assert.equal(codeOf(() => assertSafeIdentifier('../etc')), 'INVALID_IDENTIFIER');
  assert.equal(codeOf(() => assertSafeIdentifier('has space')), 'INVALID_IDENTIFIER');
  assert.equal(assertSafeCatalogKey('blog.categories'), 'blog.categories');
  assert.equal(codeOf(() => assertSafeCatalogKey('Blog/Cat')), 'INVALID_IDENTIFIER');
});

test('extension allowlist and known keys', () => {
  assert.equal(assertAllowedExtension('manage.conf', ['.conf']), '.conf');
  assert.equal(codeOf(() => assertAllowedExtension('manage.txt', ['.conf'])), 'DISALLOWED_EXTENSION');
  assert.equal(codeOf(() => assertKnownKeys({ a: 1, bad: 2 }, ['a'])), 'UNKNOWN_KEY');
});

test('resolveWithinRoot contains valid relative paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'paths-'));
  try {
    const p = resolveWithinRoot(root, 'pm2/manage.config.js', { allowedExtensions: ['.js'] });
    assert.ok(p.startsWith(root));
    assert.equal(isWithinRoot(root, 'nginx/manage.conf'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveWithinRoot rejects traversal, encoded traversal, mixed separators, absolute', () => {
  const root = mkdtempSync(join(tmpdir(), 'paths-'));
  try {
    assert.equal(codeOf(() => resolveWithinRoot(root, '../escape')), 'PATH_TRAVERSAL');
    assert.equal(codeOf(() => resolveWithinRoot(root, '%2e%2e/escape')), 'PATH_TRAVERSAL');
    assert.equal(codeOf(() => resolveWithinRoot(root, '..\\escape')), 'PATH_TRAVERSAL');
    assert.equal(codeOf(() => resolveWithinRoot(root, '/etc/passwd')), 'ABSOLUTE_PATH');
    assert.equal(codeOf(() => resolveWithinRoot(root, 'C:\\Windows')), 'ABSOLUTE_PATH');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveWithinRoot detects symlink escape (skipped if symlinks unavailable)', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'paths-'));
  const root = join(base, 'root');
  const outside = join(base, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.js'), '// secret');
  let linked = false;
  try {
    symlinkSync(outside, join(root, 'link'), 'dir');
    linked = true;
  } catch {
    t.skip('symlinks not permitted in this environment');
  }
  try {
    if (linked) {
      assert.equal(codeOf(() => resolveWithinRoot(root, 'link/secret.js', { allowedExtensions: ['.js'] })), 'SYMLINK_ESCAPE');
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('assertNotSecretOrRuntimePath blocks secret/log roots', () => {
  const base = mkdtempSync(join(tmpdir(), 'paths-'));
  try {
    const secrets = join(base, 'secrets');
    const inside = join(secrets, 'argus.env');
    assert.equal(
      codeOf(() => assertNotSecretOrRuntimePath(inside, { secretRoots: [secrets] })),
      'PATH_VIOLATION'
    );
    // A path outside the secret root is fine.
    assert.doesNotThrow(() => assertNotSecretOrRuntimePath(join(base, 'data', 'x.json'), { secretRoots: [secrets] }));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
