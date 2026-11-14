// Manage authentication: single admin password (developer decision — no user
// accounts). The password is stored ONLY as a scrypt hash in the server-private
// env file (MANAGE_ADMIN_PASSWORD_HASH). Sessions are server-side; the browser
// holds an opaque, HMAC-signed id in an HttpOnly/SameSite=Strict cookie, and
// every state-changing request must carry the session's CSRF token.

import { scryptSync, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';

const SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 64 });

export function hashPassword(password) {
  const salt = randomBytes(16);
  const key = scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** Constant-time verify; false on any malformed input (never throws). */
export function verifyPassword(password, stored) {
  if (typeof password !== 'string' || password.length === 0 || password.length > 1024) return false;
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, keyB64] = parts;
  try {
    const expected = Buffer.from(keyB64, 'base64');
    const key = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 64 * 1024 * 1024
    });
    return key.length === expected.length && timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

export class SessionStore {
  constructor({ secret, absoluteMs = 12 * 3600_000, idleMs = 2 * 3600_000, now = () => Date.now() }) {
    if (!secret) throw new Error('SessionStore requires a secret');
    this.secret = secret;
    this.absoluteMs = absoluteMs;
    this.idleMs = idleMs;
    this.now = now;
    this.sessions = new Map();
  }

  #sign(sid) {
    return createHmac('sha256', this.secret).update(sid).digest('base64url');
  }

  create() {
    const sid = randomBytes(32).toString('base64url');
    const t = this.now();
    const session = { csrf: randomBytes(24).toString('base64url'), createdAt: t, lastSeen: t };
    this.sessions.set(sid, session);
    return { cookieValue: `${sid}.${this.#sign(sid)}`, csrf: session.csrf };
  }

  /** Resolve a cookie value to a live session (touches idle timer) or null. */
  get(cookieValue) {
    const [sid, sig] = String(cookieValue || '').split('.');
    if (!sid || !sig || !safeEqual(sig, this.#sign(sid))) return null;
    const s = this.sessions.get(sid);
    if (!s) return null;
    const t = this.now();
    if (t - s.createdAt > this.absoluteMs || t - s.lastSeen > this.idleMs) {
      this.sessions.delete(sid);
      return null;
    }
    s.lastSeen = t;
    return { sid, ...s };
  }

  destroy(cookieValue) {
    const [sid] = String(cookieValue || '').split('.');
    if (sid) this.sessions.delete(sid);
  }

  checkCsrf(session, token) {
    return Boolean(session && token) && safeEqual(session.csrf, token);
  }
}

/** Per-client login failure limiter (in memory; resets on restart). */
export class LoginLimiter {
  constructor({ max = 5, windowMs = 15 * 60_000, now = () => Date.now() } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
    this.failures = new Map();
  }

  check(key) {
    const f = this.failures.get(key);
    if (!f) return { allowed: true };
    if (this.now() - f.first > this.windowMs) {
      this.failures.delete(key);
      return { allowed: true };
    }
    if (f.count >= this.max) {
      return { allowed: false, retryAfterSec: Math.ceil((f.first + this.windowMs - this.now()) / 1000) };
    }
    return { allowed: true };
  }

  fail(key) {
    const f = this.failures.get(key);
    if (!f || this.now() - f.first > this.windowMs) this.failures.set(key, { first: this.now(), count: 1 });
    else f.count += 1;
  }

  reset(key) {
    this.failures.delete(key);
  }
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export const SESSION_COOKIE = 'manage_sid';

export function sessionCookie(value, { secure, maxAgeSec = 12 * 3600 }) {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSec}`,
    ...(secure ? ['Secure'] : [])
  ].join('; ');
}
