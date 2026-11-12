import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Mutex, AppScheduler } from '../../services/argus/locks.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('mutex serializes and releases even when the holder throws', async () => {
  const m = new Mutex();
  await assert.rejects(m.withLock(async () => { throw new Error('boom'); }));
  assert.equal(m.locked, false);
  const order = [];
  await Promise.all([
    m.withLock(async () => { order.push('a1'); await sleep(30); order.push('a2'); }),
    m.withLock(async () => { order.push('b1'); order.push('b2'); })
  ]);
  assert.deepEqual(order, ['a1', 'a2', 'b1', 'b2']);
});

test('mutex acquire times out with LOCK_TIMEOUT', async () => {
  const m = new Mutex();
  const release = await m.acquire();
  await assert.rejects(m.acquire(50), (e) => e.code === 'LOCK_TIMEOUT');
  release();
});

test('same-app jobs serialize; latest pending supersedes older queued jobs', async () => {
  const log = [];
  const superseded = [];
  const s = new AppScheduler(
    async (job) => { log.push(`start:${job.operationId}`); await sleep(40); log.push(`end:${job.operationId}`); },
    (old, by) => superseded.push([old.operationId, by.operationId])
  );
  s.submit({ application: 'a', operationId: 'j1' });
  const q2 = s.submit({ application: 'a', operationId: 'j2' });
  const q3 = s.submit({ application: 'a', operationId: 'j3' });
  assert.equal(q2.queued, true);
  assert.equal(q3.superseded, 'j2');
  await s.idle('a');
  assert.deepEqual(log, ['start:j1', 'end:j1', 'start:j3', 'end:j3']); // j1 never aborted; j2 skipped
  assert.deepEqual(superseded, [['j2', 'j3']]);
});

test('different apps run concurrently', async () => {
  const running = new Set();
  let maxParallel = 0;
  const s = new AppScheduler(async () => {
    running.add(1 + running.size);
    maxParallel = Math.max(maxParallel, running.size);
    await sleep(40);
    running.delete(running.size);
  });
  s.submit({ application: 'a', operationId: 'a1' });
  s.submit({ application: 'b', operationId: 'b1' });
  await Promise.all([s.idle('a'), s.idle('b')]);
  assert.equal(maxParallel, 2);
});

test('slot is released after a failing job (no permanent lock)', async () => {
  const ran = [];
  const s = new AppScheduler(async (job) => {
    ran.push(job.operationId);
    if (job.operationId === 'bad') throw new Error('fail');
  });
  s.submit({ application: 'a', operationId: 'bad' });
  await s.idle('a');
  assert.equal(s.isRunning('a'), false);
  s.submit({ application: 'a', operationId: 'next' });
  await s.idle('a');
  assert.deepEqual(ran, ['bad', 'next']);
});
