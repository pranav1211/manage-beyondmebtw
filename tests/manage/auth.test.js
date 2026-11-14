import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, SessionStore, LoginLimiter, parseCookies, sessionCookie } from '../../services/manage-api/auth.js';

test('scrypt hash verifies the right password and rejects others', () => {
  const h = hashPassword('correct horse battery staple');
  assert.match(h, /^scrypt\$16384\$8\$1\$/);
  assert.equal(verifyPassword('correct horse battery staple', h), true);
  assert.equal(verifyPassword('wrong', h), false);
  assert.equal(verifyPassword('', h), false);
  assert.equal(verifyPassword('x', 'not-a-hash'), false);
  assert.equal(verifyPassword('x', undefined), false);
});

test('sessions expire on idle and absolute limits; tampered ids rejected', () => {
  let now = 0;
  const s = new SessionStore({ secret: 'k', idleMs: 100, absoluteMs: 1000, now: () => now });
  const { cookieValue } = s.create();
  assert.ok(s.get(cookieValue));
  assert.equal(s.get(cookieValue.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'))), null, 'signature must match');
  now = 90; assert.ok(s.get(cookieValue));
  now = 250; assert.equal(s.get(cookieValue), null, 'idle expiry');
  const second = s.create().cookieValue;
  for (now = 300; now <= 1300; now += 90) s.get(second);
  assert.equal(s.get(second), null, 'absolute expiry');
});

test('logout destroys the session; CSRF must match', () => {
  const s = new SessionStore({ secret: 'k' });
  const { cookieValue, csrf } = s.create();
  const sess = s.get(cookieValue);
  assert.equal(s.checkCsrf(sess, csrf), true);
  assert.equal(s.checkCsrf(sess, 'nope'), false);
  assert.equal(s.checkCsrf(sess, undefined), false);
  s.destroy(cookieValue);
  assert.equal(s.get(cookieValue), null);
});

test('login limiter blocks after max failures and resets on success', () => {
  let now = 0;
  const l = new LoginLimiter({ max: 3, windowMs: 1000, now: () => now });
  for (let i = 0; i < 3; i++) l.fail('ip');
  assert.equal(l.check('ip').allowed, false);
  now = 1500;
  assert.equal(l.check('ip').allowed, true, 'window elapsed');
  l.fail('ip'); l.reset('ip');
  assert.equal(l.check('ip').allowed, true);
});

test('cookie is HttpOnly + SameSite=Strict, Secure only when asked', () => {
  assert.match(sessionCookie('v', { secure: true }), /HttpOnly; SameSite=Strict; Max-Age=\d+; Secure$/);
  assert.ok(!sessionCookie('v', { secure: false }).includes('Secure'));
  assert.deepEqual(parseCookies('a=1; manage_sid=x.y'), { a: '1', manage_sid: 'x.y' });
});
