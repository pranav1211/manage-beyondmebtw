// Locking for Argus.
//
// - Mutex: FIFO async lock with a bounded acquire timeout (LOCK_TIMEOUT).
//   Used for the infrastructure lock (Config Repo Git + Nginx) and for any
//   shared working state.
// - AppScheduler: per-application serialization with latest-pending-commit
//   coalescing. A running deployment is never aborted; while it runs, only the
//   NEWEST queued job is kept (older queued jobs are superseded). Different
//   applications run concurrently. The app slot is always released — success,
//   failure, or throw.

import { AppError } from '../../shared/errors.js';

export class Mutex {
  #locked = false;
  #waiters = [];

  get locked() {
    return this.#locked;
  }

  acquire(timeoutMs = 60_000) {
    if (!this.#locked) {
      this.#locked = true;
      return Promise.resolve(this.#releaser());
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, timer: null };
      waiter.timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((w) => w !== waiter);
        reject(new AppError('LOCK_TIMEOUT', 'Timed out waiting for lock'));
      }, timeoutMs);
      this.#waiters.push(waiter);
    });
  }

  #releaser() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#waiters.shift();
      if (next) {
        clearTimeout(next.timer);
        next.resolve(this.#releaser());
      } else {
        this.#locked = false;
      }
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
}

export class AppScheduler {
  /**
   * @param {(job:object)=>Promise<any>} runJob executes one job
   * @param {(superseded:object, by:object)=>void} [onSuperseded]
   */
  constructor(runJob, onSuperseded = () => {}) {
    this.runJob = runJob;
    this.onSuperseded = onSuperseded;
    this.slots = new Map(); // app -> { running: job|null, pending: job|null, idle: Promise }
  }

  isRunning(app) {
    const s = this.slots.get(app);
    return Boolean(s && s.running);
  }

  /** Submit a job for job.application. Returns { started } or { queued, superseded }. */
  submit(job) {
    const app = job.application;
    let slot = this.slots.get(app);
    if (!slot) {
      slot = { running: null, pending: null, done: null };
      this.slots.set(app, slot);
    }
    if (slot.running) {
      const superseded = slot.pending;
      slot.pending = job;
      if (superseded) this.onSuperseded(superseded, job);
      return { queued: true, superseded: superseded ? superseded.operationId : null };
    }
    slot.done = this.#drain(slot, job);
    return { started: true };
  }

  async #drain(slot, first) {
    let job = first;
    while (job) {
      slot.running = job;
      try {
        await this.runJob(job);
      } catch {
        // runJob records its own failure; the slot must still move on.
      } finally {
        slot.running = null;
      }
      job = slot.pending;
      slot.pending = null;
    }
  }

  /** Resolve when the application's slot is idle (tests / graceful shutdown). */
  async idle(app) {
    const slot = this.slots.get(app);
    while (slot && (slot.running || slot.pending)) {
      await slot.done;
    }
  }
}
