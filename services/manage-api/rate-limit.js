// Per-API-token rate limits for the data API (token bucket per client id).
//
// Policy (developer-approved, sized from real usage — tens of saves a day):
//   writes  30/min, burst 10      reads  300/min, burst 60
// Only Manage-issued app tokens are limited; public reads and the admin session
// are not. A refused request is answered with 429 + Retry-After BEFORE any
// handler runs, so it can never partially mutate canonical data.

export const DEFAULT_TOKEN_LIMITS = Object.freeze({
  write: { perMinute: 30, burst: 10 },
  read: { perMinute: 300, burst: 60 }
});

export class TokenBucketLimiter {
  #buckets = new Map(); // key -> { tokens, at }
  #rate;
  #burst;
  #now;

  constructor({ perMinute, burst, now = () => Date.now() }) {
    this.#rate = perMinute / 60_000; // tokens per ms
    this.#burst = burst;
    this.#now = now;
  }

  /** @returns {{allowed: boolean, retryAfterSec: number}} */
  take(key) {
    const t = this.#now();
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
