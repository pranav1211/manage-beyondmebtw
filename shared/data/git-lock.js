// Cross-process lock for all checkout-mutating Git activity on one repository
// checkout (bmb-data). Registry writes, canonical-data writes, webhook syncs and
// push retries all go through it, so they can never race on the working tree.
//
// - In-process: a FIFO Mutex (bounded wait -> LOCK_TIMEOUT).
// - Cross-process: a lockfile created ATOMICALLY with its owner record
//   (write temp + hard link; link fails if the lockfile exists).
// - Stale recovery: a lock is taken over ONLY when its owner process is provably
//   gone (same host, pid not alive, or our own pid but a different nonce = a
//   previous incarnation). Age alone never steals a lock. A live holder makes
//   waiters time out with LOCK_TIMEOUT (visible), never silently disappear.

import { writeFileSync, linkSync, unlinkSync, readFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { AppError } from '../errors.js';
import { Mutex } from '../../services/argus/locks.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists, owned by someone else
  }
}

export class GitLock {
  #mutex = new Mutex();
  #file;
  #onRecover;
  #heldNonce = null;

  /**
   * @param {string} file lockfile path (outside the Git tree)
   * @param {object} [opts]
   * @param {(info:object)=>void} [opts.onRecover] called when a stale lock is taken over
   */
  constructor(file, { onRecover } = {}) {
    this.#file = file;
    this.#onRecover = onRecover || (() => {});
  }

  get file() {
    return this.#file;
  }

  holder() {
    try {
      return JSON.parse(readFileSync(this.#file, 'utf8'));
    } catch {
      return null;
    }
  }

  async acquire(timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    const releaseMutex = await this.#mutex.acquire(timeoutMs);
    try {
      await this.#acquireFile(deadline);
    } catch (err) {
      releaseMutex();
      throw err;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const h = this.holder();
      if (h && h.nonce === this.#heldNonce) {
        try { unlinkSync(this.#file); } catch { /* already gone */ }
      }
      this.#heldNonce = null;
      releaseMutex();
    };
  }

  async withLock(fn, timeoutMs) {
    const release = await this.acquire(timeoutMs);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async #acquireFile(deadline) {
    mkdirSync(dirname(this.#file), { recursive: true });
    const nonce = randomBytes(8).toString('hex');
    const record = { pid: process.pid, hostname: hostname(), nonce, acquiredAt: new Date().toISOString() };
    const tmp = `${this.#file}.${nonce}.tmp`;
    writeFileSync(tmp, JSON.stringify(record));
    try {
      for (;;) {
        try {
          linkSync(tmp, this.#file);
          this.#heldNonce = nonce;
          return;
        } catch (err) {
          if (err.code !== 'EEXIST') throw err;
        }
        const h = this.holder();
        const stale =
          h &&
          h.hostname === hostname() &&
          (!pidAlive(h.pid) || (h.pid === process.pid && h.nonce !== nonce));
        if (stale) {
          // Move it aside (kept for evidence) and retry the atomic create.
          const aside = `${this.#file}.stale-${Date.now()}`;
          try {
            renameSync(this.#file, aside);
            this.#onRecover({ action: 'stale-lock-recovered', previous: h, movedTo: aside });
          } catch { /* someone else handled it */ }
          continue;
        }
        if (Date.now() >= deadline) {
          throw new AppError('LOCK_TIMEOUT', 'Timed out waiting for the data repository lock', {
            holder: h ? { pid: h.pid, acquiredAt: h.acquiredAt } : null
          });
        }
        await sleep(100);
      }
    } finally {
      try { unlinkSync(tmp); } catch { /* ignore */ }
    }
  }
}

/** Per-key FIFO locks (resource-level serialization). */
export class KeyedMutex {
  #locks = new Map();

  async withLocks(keys, fn, timeoutMs = 60_000) {
    // Sorted acquisition order prevents deadlock between multi-key operations.
    const sorted = [...new Set(keys)].sort();
    const releases = [];
    try {
      for (const k of sorted) {
        if (!this.#locks.has(k)) this.#locks.set(k, new Mutex());
        releases.push(await this.#locks.get(k).acquire(timeoutMs));
      }
      return await fn();
    } finally {
      for (const r of releases.reverse()) r();
    }
  }
}
