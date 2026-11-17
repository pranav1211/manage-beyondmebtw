// Rate limits for the data API (token buckets).
//
// Per app token (developer-approved, sized from real usage, tens of saves a day):
//   writes  30/min, burst 10      reads  300/min, burst 60
// Per visitor IP for anonymous requests (public reads, and requests with an invalid token):
//   240/min, burst 120. A blog page view is ~6 reads, so real visitors never notice;
//   a script hammering the public URLs is slowed to 4 requests a second.
// The admin session is not limited. A refused request is answered with 429 + Retry-After
// BEFORE any handler runs, so it can never partially mutate canonical data.

export const DEFAULT_TOKEN_LIMITS = Object.freeze({
  write: { perMinute: 30, burst: 10 },
  read: { perMinute: 300, burst: 60 }
});

export const DEFAULT_PUBLIC_LIMITS = Object.freeze({ perMinute: 240, burst: 120 });

export class TokenBucketLimiter {
  #buckets = new Map(); // key -> { tokens, at }
  #rate;
  #burst;
  #now;
  #maxKeys;

  /** maxKeys bounds memory when keys are visitor IPs: idle (full) buckets are dropped first. */
  constructor({ perMinute, burst, now = () => Date.now(), maxKeys = 10_000 }) {
    this.#rate = perMinute / 60_000; // tokens per ms
    this.#burst = burst;
    this.#now = now;
    this.#maxKeys = maxKeys;
  }

  get size() {
    return this.#buckets.size;
  }

  #prune(t) {
    // A bucket that has refilled completely carries no state: forgetting it changes nothing.
    for (const [k, b] of this.#buckets) if (b.tokens + (t - b.at) * this.#rate >= this.#burst) this.#buckets.delete(k);
    // Still too many distinct keys (a flood from many addresses): drop the oldest-inserted.
    for (const k of this.#buckets.keys()) {
      if (this.#buckets.size < this.#maxKeys) break;
      this.#buckets.delete(k);
    }
  }

  /** @returns {{allowed: boolean, retryAfterSec: number}} */
  take(key) {
    const t = this.#now();
    if (this.#buckets.size >= this.#maxKeys && !this.#buckets.has(key)) this.#prune(t);
    const b = this.#buckets.get(key) || { tokens: this.#burst, at: t };
    b.tokens = Math.min(this.#burst, b.tokens + (t - b.at) * this.#rate);
    b.at = t;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      this.#buckets.set(key, b);
      return { allowed: true, retryAfterSec: 0 };
    }
    this.#buckets.set(key, b);
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((1 - b.tokens) / this.#rate / 1000)) };
  }
}
