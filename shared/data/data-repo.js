// DataRepo: the single, coordinated writer for one bmb-data checkout.
//
// Every mutation — registry or canonical data — runs as a journaled operation
// under ONE cross-process Git lock:
//
//   preflight   identity, branch, clean tree; fetch; fast-forward when the
//               remote advanced cleanly; block on divergence (never reset)
//   staging     after-content copies written durably to the journal (outside Git)
//   prepared    copies re-read + validated (hash + caller validator)
//   applied     targets replaced atomically (tmp + fsync + rename) / deleted
//   committed   exact-path `git add` (never `.`/-A), commit tagged with the op id
//   pushed      fast-forward push (never --force), bounded retries
//   verified    commit is on the remote branch and each file at that commit
//               hashes to the intended content (remote read-back)
//
// Recovery (startup or explicit retry) is deterministic and idempotent:
//   phase < prepared  -> discard: canonical files were never touched (pre-state)
//   phase >= prepared -> roll forward from the journal to the post-state, then
//                        commit/push/verify. Commit is found by its op tag, a push
//                        whose response was lost is detected by ancestry, so a
//                        retry never duplicates a commit or a mutation.
// A failed push leaves the commit durable and the op `pending-push` (never
// reported as saved). Divergence/conflict = `blocked` with diagnostics.
// Journals/history live under stateRoot (runtime, never in Git, no secrets,
// no payloads in history — content copies are deleted once committed).

import { mkdirSync, readdirSync, existsSync, rmSync, appendFileSync } from 'node:fs';
import { join, dirname, basename, relative, resolve, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AppError, sanitizeError } from '../errors.js';
import { resolveWithinRoot } from '../validation/paths.js';
import { run, tail } from '../exec.js';
import { writeDurable, readTextOrNull, hashOrNull, sha256, removeDurable, normalizeText } from './durable.js';
import { GitLock, KeyedMutex } from './git-lock.js';
import { Mutex } from '../../services/argus/locks.js';

export const PHASES = Object.freeze(['preflight', 'staging', 'prepared', 'applied', 'committed', 'pushed', 'verified']);
const rank = (p) => PHASES.indexOf(p);
const OP_ID_RE = /^dop_[a-z0-9]+_[0-9a-f]{8}$/;
const BLOCKING_CODES = new Set(['DATA_REPO_DIVERGED', 'DATA_REPO_DIRTY', 'DATA_REPO_UNAVAILABLE', 'CONFLICT']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const normRemote = (u) => String(u).replace(/\\/g, '/').replace(/\/+$/, '');

/** Thrown by test fault hooks to simulate a process crash at a given point. */
export class SimulatedCrash extends Error {
  constructor(point) {
    super(`simulated crash at ${point}`);
    this.name = 'SimulatedCrash';
    this.point = point;
  }
}

/**
 * @param {object} p
 * @param {string} p.root absolute bmb-data checkout path
 * @param {string} [p.branch]
 * @param {string} p.expectedRemote origin URL the checkout must have
 * @param {string} p.stateRoot runtime dir (journal, history, lock) — outside the checkout
 * @param {string[]} [p.allowedPrefixes] repo-relative prefixes this workflow may write
 * @param {{name:string,email:string}} [p.author]
 * @param {(point:string, op:object, i?:number)=>void|Promise<void>} [p.faults] test-only fault hook
 * @param {number} [p.pushAttempts]
 * @param {number[]} [p.pushBackoffMs]
 * @param {number} [p.lockTimeoutMs]
 */
export function createDataRepo({
  root,
  branch = 'main',
  expectedRemote,
  stateRoot,
  allowedPrefixes = ['data/', 'content/', 'registry/'],
  author = { name: 'manage', email: 'manage@localhost' },
  faults = null,
  pushAttempts = 3,
  pushBackoffMs = [500, 1500],
  lockTimeoutMs = 60_000
}) {
  if (!root || !stateRoot || !expectedRemote) throw new AppError('CONFIG_INVALID', 'DataRepo requires root, stateRoot and expectedRemote');
  const relState = relative(resolve(root), resolve(stateRoot));
  if (!relState.startsWith('..') && !isAbsolute(relState)) {
    throw new AppError('CONFIG_INVALID', 'Data operation state must live outside the bmb-data checkout');
  }
  const opsDir = join(stateRoot, 'ops');
  const journalDir = join(stateRoot, 'journal');
  const eventsFile = join(stateRoot, 'events.log');
  mkdirSync(opsDir, { recursive: true });
  mkdirSync(journalDir, { recursive: true });

  const event = (e) => {
    try { appendFileSync(eventsFile, JSON.stringify({ at: new Date().toISOString(), ...e }) + '\n'); } catch { /* best effort */ }
  };
  const lock = new GitLock(join(stateRoot, 'bmb-data.git.lock'), { onRecover: (info) => event(info) });
  const resourceLocks = new KeyedMutex();
  const structuralLock = new Mutex();

  const now = () => new Date().toISOString();
  const newId = () => `dop_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
  const fault = async (point, op, i) => { if (faults) await faults(point, op, i); };

  // ── Git ─────────────────────────────────────────────────────────────────
  async function git(args, { allowFail = false } = {}) {
    const r = await run('git', ['-C', root, ...args]);
    if (r.code !== 0 && !allowFail) throw new AppError('GIT_FAILED', `git ${args[0]} failed`, { output: tail(r.stderr || r.stdout) });
    return r;
  }
  const revOrNull = async (ref) => {
    const r = await git(['rev-parse', '--verify', '-q', ref], { allowFail: true });
    return r.code === 0 ? r.stdout.trim() : null;
  };
  const isAncestor = async (a, b) => (await git(['merge-base', '--is-ancestor', a, b], { allowFail: true })).code === 0;

  async function assertIdentity() {
    const remote = (await git(['remote', 'get-url', 'origin'])).stdout.trim();
    if (normRemote(remote) !== normRemote(expectedRemote)) {
      throw new AppError('DATA_REPO_UNAVAILABLE', 'Repository remote does not match the expected identity');
    }
    const current = (await git(['symbolic-ref', '--short', 'HEAD'])).stdout.trim();
    if (current !== branch) throw new AppError('DATA_REPO_UNAVAILABLE', 'Checkout is on an unexpected branch', { expected: branch, actual: current });
  }

  async function dirtyPaths() {
    const s = (await git(['status', '--porcelain', '--untracked-files=all'])).stdout.trim();
    return s ? s.split('\n').map((l) => l.slice(3)) : [];
  }

  /** Identity + clean + remote advancement. Remote outage is tolerated (push will be pending). */
  async function preflight() {
    await assertIdentity();
    const dirty = await dirtyPaths();
    if (dirty.length) throw new AppError('DATA_REPO_DIRTY', 'Repository has unexpected local changes; refusing to write', { paths: dirty.slice(0, 20) });
    const ls = await git(['ls-remote', '--heads', 'origin', branch], { allowFail: true });
    if (ls.code !== 0) return { remoteReachable: false };
    if (ls.stdout.trim() === '') return { remoteReachable: true, remoteHasBranch: false };
    await git(['fetch', '-q', 'origin', branch]);
    const local = await revOrNull('HEAD');
    if (!local) {
      await git(['checkout', '-q', '-B', branch, `origin/${branch}`]);
      return { remoteReachable: true, remoteHasBranch: true };
    }
    const upstream = await revOrNull(`origin/${branch}`);
    if (local !== upstream) {
      if (await isAncestor(local, upstream)) await git(['merge', '-q', '--ff-only', `origin/${branch}`]);
      else if (!(await isAncestor(upstream, local))) {
        throw new AppError('DATA_REPO_DIVERGED', 'Repository diverged from its remote; resolve explicitly (no force-push)', { local, remote: upstream });
      }
      // ahead: earlier commit(s) not pushed yet — pushed with this operation.
    }
    return { remoteReachable: true, remoteHasBranch: true };
  }

  // ── Paths ───────────────────────────────────────────────────────────────
  function owned(relPath) {
    const norm = String(relPath).replace(/\\/g, '/');
    if (!allowedPrefixes.some((p) => norm.startsWith(p))) {
      throw new AppError('PATH_VIOLATION', 'Path is not owned by the data workflow', { path: norm });
    }
    resolveWithinRoot(root, norm); // traversal, encoded traversal, absolute, symlink escape
    return norm;
  }
  const abs = (rel) => resolveWithinRoot(root, rel);
  const journalCopy = (op, i) => join(journalDir, op.operationId, `${i}.after`);

  // ── Records ─────────────────────────────────────────────────────────────
  function saveOp(op) {
    op.updatedAt = now();
    writeDurable(join(opsDir, `${op.operationId}.json`), JSON.stringify(op, null, 2) + '\n');
    return op;
  }
  function getOp(id) {
    if (!OP_ID_RE.test(String(id))) return null;
    const t = readTextOrNull(join(opsDir, `${id}.json`));
    return t === null ? null : JSON.parse(t);
  }
  function allOps() {
    return readdirSync(opsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => { try { return JSON.parse(readTextOrNull(join(opsDir, f))); } catch { return null; } })
      .filter(Boolean)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }
  const errorOf = (err) => (err instanceof AppError ? sanitizeError(err) : { code: 'INTERNAL', message: String(err && err.message ? err.message : err) });
  const cleanupJournal = (op) => rmSync(join(journalDir, op.operationId), { recursive: true, force: true });

  /** Remove our own temp files (crash during an atomic replace) next to targets. */
  function removeStrayTemps(op) {
    for (const c of op.changes) {
      const dir = dirname(abs(c.relPath));
      if (!existsSync(dir)) continue;
      const base = basename(c.relPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`^\\.${base}\\.\\d+\\.[0-9a-f]{8}\\.tmp$`);
      for (const f of readdirSync(dir)) if (re.test(f)) rmSync(join(dir, f), { force: true });
    }
  }

  // ── Steps ───────────────────────────────────────────────────────────────
  async function stepApply(op) {
    for (const [i, c] of op.changes.entries()) {
      const target = abs(c.relPath);
      const cur = hashOrNull(target);
      if (cur === c.after) continue; // already applied (roll-forward is idempotent)
      if (cur !== c.before) throw new AppError('CONFLICT', 'Target changed outside this operation', { path: c.relPath });
      if (c.after === null) removeDurable(target);
      else {
        const content = readTextOrNull(journalCopy(op, i));
        if (content === null || sha256(content) !== c.after) throw new AppError('DATA_INTEGRITY', 'Journal copy is missing or corrupt', { path: c.relPath });
        writeDurable(target, content);
      }
      await fault('applying', op, i);
    }
  }

  async function stepCommit(op) {
    const tagged = (await git(['log', '--format=%H', '-n', '1', '--fixed-strings', `--grep=Operation: ${op.operationId}`], { allowFail: true })).stdout.trim();
    if (tagged) {
      op.commit = tagged;
      return;
    }
    const paths = [];
    for (const c of op.changes) {
      const tracked = (await git(['ls-files', '--error-unmatch', '--', c.relPath], { allowFail: true })).code === 0;
      if (c.after !== null || tracked) paths.push(c.relPath);
    }
    if (paths.length) await git(['add', '--', ...paths]);
    const staged = (await git(['diff', '--cached', '--name-only'])).stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    const unexpected = staged.filter((p) => !op.changes.some((c) => c.relPath === p));
    if (unexpected.length) throw new AppError('PATH_VIOLATION', 'Unexpected staged paths; refusing to commit', { paths: unexpected });
    await fault('staged', op);
    if (!staged.length) throw new AppError('DATA_INTEGRITY', 'Nothing staged for an operation that changes content');
    const message = `${op.message}\n\nOperation: ${op.operationId}\nResources: ${op.keys.join(', ')}`;
    await git(['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`, 'commit', '-q', '-m', message]);
    op.commit = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    const files = (await git(['show', '--name-only', '--format=', op.commit])).stdout.split('\n').filter(Boolean).sort();
    op.committedPaths = files;
  }

  /** @returns {'pushed'|'already'|'pending'} */
  async function stepPush(op) {
    const ls = await git(['ls-remote', '--heads', 'origin', branch], { allowFail: true });
    if (ls.code !== 0) {
      op.lastError = { code: 'GIT_FAILED', message: 'Remote unavailable; commit kept locally and retryable', details: { output: tail(ls.stderr) } };
      return 'pending';
    }
    if (ls.stdout.trim() !== '') {
      const f = await git(['fetch', '-q', 'origin', branch], { allowFail: true });
      if (f.code !== 0) {
        op.lastError = { code: 'GIT_FAILED', message: 'Fetch failed; commit kept locally and retryable', details: { output: tail(f.stderr) } };
        return 'pending';
      }
      if (await isAncestor(op.commit, `origin/${branch}`)) return 'already'; // pushed earlier; response was lost
      if (!(await isAncestor(`origin/${branch}`, 'HEAD'))) {
        throw new AppError('DATA_REPO_DIVERGED', 'Remote advanced while this change was unpushed; resolve explicitly (no force-push)', {
          local: await revOrNull('HEAD'),
          remote: await revOrNull(`origin/${branch}`)
        });
      }
    }
    let out = '';
    for (let attempt = 1; attempt <= pushAttempts; attempt++) {
      op.pushAttempts = (op.pushAttempts || 0) + 1;
      await fault('pushing', op);
      const p = await git(['push', '-q', 'origin', `HEAD:refs/heads/${branch}`], { allowFail: true });
      if (p.code === 0) return 'pushed';
      out = tail(p.stderr || p.stdout);
      if (/non-fast-forward|rejected|fetch first/i.test(out)) {
        throw new AppError('DATA_REPO_DIVERGED', 'Push rejected: remote advanced; resolve explicitly (no force-push)', { output: out });
      }
      if (attempt < pushAttempts) await sleep(pushBackoffMs[attempt - 1] ?? pushBackoffMs[pushBackoffMs.length - 1] ?? 0);
    }
    op.lastError = { code: 'GIT_FAILED', message: 'Push failed; commit kept locally and retryable', details: { output: out } };
    return 'pending';
  }

  async function stepVerify(op) {
    await git(['fetch', '-q', 'origin', branch]);
    if (!(await isAncestor(op.commit, `origin/${branch}`))) {
      throw new AppError('DATA_REPO_DIVERGED', 'Commit is not on the remote branch after push', { commit: op.commit });
    }
    for (const c of op.changes) {
      const shown = await git(['show', `${op.commit}:${c.relPath}`], { allowFail: true });
      const got = shown.code === 0 ? sha256(shown.stdout) : null;
      if (got !== c.after) throw new AppError('DATA_INTEGRITY', 'Remote read-back does not match the intended content', { path: c.relPath });
    }
  }

  /** Other ops whose commit reached the remote with this push are settled too. */
  async function settlePending(by) {
    for (const op of allOps()) {
      if (op.operationId === by.operationId || op.status !== 'pending-push' || !op.commit) continue;
      if (!(await isAncestor(op.commit, `origin/${branch}`))) continue;
      try {
        await stepVerify(op);
        Object.assign(op, { phase: 'verified', status: 'succeeded', pushed: true, readBackVerified: true, pushedWith: by.operationId, lastError: null, finishedAt: now() });
      } catch (err) {
        op.lastError = errorOf(err);
      }
      saveOp(op);
    }
  }

  /** Drive an op from its current phase to a terminal/pending state. Never throws (except SimulatedCrash). */
  async function advance(op) {
    try {
      if (rank(op.phase) < rank('applied')) {
        await stepApply(op);
        op.phase = 'applied';
        saveOp(op);
        await fault('applied', op);
      }
      if (rank(op.phase) < rank('committed')) {
        await stepCommit(op);
        op.phase = 'committed';
        saveOp(op);
        cleanupJournal(op);
        await fault('committed', op);
      }
      if (rank(op.phase) < rank('pushed')) {
        const r = await stepPush(op);
        if (r === 'pending') {
          op.status = 'pending-push';
          return saveOp(op);
        }
        await fault('push-done', op); // pushed, but the record/response may be lost
        op.phase = 'pushed';
        op.pushed = true;
        saveOp(op);
      }
      if (rank(op.phase) < rank('verified')) {
        await stepVerify(op);
        op.phase = 'verified';
        op.readBackVerified = true;
      }
      Object.assign(op, { status: 'succeeded', lastError: null, finishedAt: now() });
      saveOp(op);
      await settlePending(op);
      return op;
    } catch (err) {
      if (err instanceof SimulatedCrash) throw err;
      op.lastError = errorOf(err);
      op.status = BLOCKING_CODES.has(err.code) ? 'blocked' : 'failed';
      return saveOp(op);
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────
  function findByIdempotencyKey(key) {
    return allOps().find((o) => o.idempotencyKey === key) || null;
  }

  /**
   * @param {object} p
   * @param {string} p.action e.g. 'registry.update', 'resource.replace'
   * @param {string[]} p.keys resource keys (for records + commit metadata)
   * @param {Array<{relPath:string, content:string|null, expectBefore?:string|null}>} p.changes content null = delete
   * @param {string} p.message commit subject (no private content, no secrets)
   * @param {(relPath:string, content:string)=>void} [p.validate] throws on invalid content
   * @param {string} [p.idempotencyKey]
   * @param {string} [p.actor]
   * @returns {Promise<object>} the operation record (status: succeeded|noop|pending-push|blocked|failed)
   * Throws AppError (details.operationId) when the operation was refused before any canonical file changed.
   */
  async function mutate({ action, keys, changes, message, validate, idempotencyKey = null, actor = 'admin' }) {
    if (!Array.isArray(changes) || changes.length === 0) throw new AppError('VALIDATION_FAILED', 'No changes');
    const norm = changes.map((c) => ({
      relPath: owned(c.relPath),
      content: c.content === null ? null : normalizeText(c.content),
      expectBefore: c.expectBefore
    }));
    if (new Set(norm.map((c) => c.relPath)).size !== norm.length) throw new AppError('VALIDATION_FAILED', 'Duplicate paths in one operation');

    return lock.withLock(async () => {
      if (idempotencyKey) {
        const prior = findByIdempotencyKey(idempotencyKey);
        if (prior) return { ...prior, replayed: true };
      }
      const op = {
        schemaVersion: 1,
        operationId: newId(),
        kind: 'mutation',
        action,
        keys,
        actor,
        idempotencyKey,
        message,
        createdAt: now(),
        phase: 'preflight',
        status: 'running',
        validation: null,
        changes: [],
        commit: null,
        pushed: false,
        readBackVerified: false,
        retryCount: 0,
        lastError: null,
        recovery: []
      };
      saveOp(op);
      try {
        await preflight();
        op.changes = norm.map((c) => ({ relPath: c.relPath, before: hashOrNull(abs(c.relPath)), after: c.content === null ? null : sha256(c.content) }));
        norm.forEach((c, i) => {
          if (c.expectBefore !== undefined && c.expectBefore !== op.changes[i].before) {
            throw new AppError('CONFLICT', 'Resource changed since it was read (revision mismatch)', { path: c.relPath });
          }
        });
        if (op.changes.every((c) => c.before === c.after)) {
          Object.assign(op, { status: 'noop', validation: 'skipped', finishedAt: now() });
          return saveOp(op);
        }

        op.phase = 'staging';
        saveOp(op);
        await fault('staging', op);
        norm.forEach((c, i) => { if (c.content !== null) writeDurable(journalCopy(op, i), c.content); });
        await fault('temp-written', op);
        norm.forEach((c, i) => {
          if (c.content === null) return;
          const copy = readTextOrNull(journalCopy(op, i));
          if (copy === null || sha256(copy) !== op.changes[i].after) throw new AppError('DATA_INTEGRITY', 'Journal copy failed verification', { path: c.relPath });
          if (validate) validate(c.relPath, copy);
        });
        op.validation = 'passed';
        await fault('validated', op);
        op.phase = 'prepared';
        saveOp(op);
        await fault('prepared', op);
      } catch (err) {
        if (err instanceof SimulatedCrash) throw err;
        cleanupJournal(op);
        op.lastError = errorOf(err);
        op.status = BLOCKING_CODES.has(err.code) ? 'blocked' : 'failed';
        op.finishedAt = now();
        saveOp(op);
        if (err instanceof AppError) {
          err.details = { ...(err.details || {}), operationId: op.operationId };
          throw err;
        }
        throw new AppError('INTERNAL', 'Data operation failed', { operationId: op.operationId });
      }
      return advance(op);
    }, lockTimeoutMs);
  }

  /** Explicit admin retry: resume an op from its recorded phase (idempotent). */
  async function retry(operationId) {
    return lock.withLock(async () => {
      const op = getOp(operationId);
      if (!op || op.kind !== 'mutation') throw new AppError('RESOURCE_NOT_FOUND', 'Data operation not found');
      if (op.status === 'succeeded' || op.status === 'noop') return { ...op, replayed: true };
      if (rank(op.phase) < rank('prepared')) {
        throw new AppError('CONFLICT', 'Operation was refused before changing anything; submit it again instead', { operationId });
      }
      await assertIdentity();
      op.retryCount = (op.retryCount || 0) + 1;
      op.status = 'running';
      saveOp(op);
      return advance(op);
    }, lockTimeoutMs);
  }

  /** Retry every pending push (registry "retry-push" compatibility). */
  async function retryPending() {
    const pending = allOps().filter((o) => o.kind === 'mutation' && o.status === 'pending-push').reverse();
    const results = [];
    for (const op of pending) results.push(await retry(op.operationId));
    return results;
  }

  /** Startup recovery of interrupted operations (deterministic, idempotent). */
  async function recover() {
    return lock.withLock(async () => {
      const outcomes = [];
      for (const op of allOps().filter((o) => o.kind === 'mutation' && (o.status === 'running' || o.status === 'pending-push')).reverse()) {
        const from = op.phase;
        if (op.status === 'running' && rank(op.phase) < rank('prepared')) {
          // Never applied: canonical files are untouched. Verify, then discard.
          cleanupJournal(op);
          const untouched = op.changes.every((c) => hashOrNull(abs(c.relPath)) === c.before);
          op.recovery.push({ at: now(), action: 'discard', from, outcome: untouched ? 'pre-operation state' : 'pre-state check failed' });
          Object.assign(op, {
            status: untouched ? 'failed' : 'blocked',
            lastError: { code: untouched ? 'OPERATION_FAILED' : 'DATA_INTEGRITY', message: 'Interrupted before validation completed; nothing was applied' },
            finishedAt: now()
          });
          saveOp(op);
          outcomes.push({ operationId: op.operationId, action: 'discard', status: op.status });
          continue;
        }
        removeStrayTemps(op);
        const action = op.status === 'pending-push' ? 'retry-push' : 'roll-forward';
        op.recovery.push({ at: now(), action, from });
        if (op.status === 'running') op.retryCount = op.retryCount || 0;
        await assertIdentity().catch((err) => { op.lastError = errorOf(err); });
        const done = await advance(op);
        done.recovery[done.recovery.length - 1].outcome = done.status;
        saveOp(done);
        outcomes.push({ operationId: op.operationId, action, status: done.status });
      }
      if (outcomes.length) event({ action: 'startup-recovery', outcomes });
      return outcomes;
    }, lockTimeoutMs);
  }

  /** Webhook: bring the checkout up to the remote (fast-forward only). */
  async function syncFromRemote({ after = null, delivery = null } = {}) {
    return lock.withLock(async () => {
      const op = { schemaVersion: 1, operationId: newId(), kind: 'sync', action: 'webhook-sync', delivery, requestedCommit: after, createdAt: now(), status: 'running', result: null, lastError: null };
      try {
        await assertIdentity();
        const dirty = await dirtyPaths();
        if (dirty.length) throw new AppError('DATA_REPO_DIRTY', 'Checkout has local changes; sync refused', { paths: dirty.slice(0, 20) });
        await git(['fetch', '-q', 'origin', branch]);
        const local = await revOrNull('HEAD');
        const upstream = await revOrNull(`origin/${branch}`);
        if (!upstream) op.result = { state: 'remote-empty' };
        else if (!local) {
          await git(['checkout', '-q', '-B', branch, `origin/${branch}`]);
          op.result = { state: 'synced', from: null, to: upstream };
        } else if (local === upstream) op.result = { state: 'up-to-date', head: local };
        else if (await isAncestor(local, upstream)) {
          await git(['merge', '-q', '--ff-only', `origin/${branch}`]);
          op.result = { state: 'synced', from: local, to: upstream };
        } else if (await isAncestor(upstream, local)) op.result = { state: 'ahead', head: local, remote: upstream, note: 'local commits pending push' };
        else throw new AppError('DATA_REPO_DIVERGED', 'Checkout diverged from the remote; resolve explicitly', { local, remote: upstream });
        op.status = op.result.state === 'synced' ? 'succeeded' : 'noop';
      } catch (err) {
        op.lastError = errorOf(err);
        op.status = BLOCKING_CODES.has(err.code) ? 'blocked' : 'failed';
      }
      op.finishedAt = now();
      return saveOp(op);
    }, lockTimeoutMs);
  }

  /** Read-only state for status views (no network). */
  async function status() {
    const ops = allOps();
    let head = null;
    let remote = null;
    let dirty = null;
    try {
      head = await revOrNull('HEAD');
      remote = await revOrNull(`origin/${branch}`);
      dirty = (await dirtyPaths()).length > 0;
    } catch { /* unavailable */ }
    return {
      branch,
      head,
      remote,
      dirty,
      pendingPush: ops.filter((o) => o.status === 'pending-push').length,
      blocked: ops.filter((o) => o.status === 'blocked').length,
      running: ops.filter((o) => o.status === 'running').length,
      lastSync: ops.find((o) => o.kind === 'sync') || null,
      lockHolder: lock.holder() ? { pid: lock.holder().pid, acquiredAt: lock.holder().acquiredAt } : null
    };
  }

  return Object.freeze({
    root,
    branch,
    mutate,
    retry,
    retryPending,
    recover,
    syncFromRemote,
    status,
    getOp,
    listOps: ({ limit = 50, kind } = {}) => allOps().filter((o) => !kind || o.kind === kind).slice(0, limit),
    resourceLocks,
    structuralLock,
    lock,
    readText: (rel) => readTextOrNull(abs(rel)),
    absPath: abs
  });
}
