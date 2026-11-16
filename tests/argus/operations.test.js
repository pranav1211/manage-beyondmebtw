// Argus restart while an operation is in flight: the record must not stay
// "running" forever.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OperationStore } from '../../services/argus/operations.js';
import { tmp } from '../helpers/argus-fixtures.js';

test('start-up marks operations left pending/running by a previous process as failed (interrupted)', () => {
  const root = tmp('ops-');
  const before = new OperationStore(root);
  const pending = before.create({ operation: 'deploy', application: 'app', params: {} });
  const running = before.create({ operation: 'build', application: 'app', params: {} });
  before.stage(running.operationId, 'sync');
  const done = before.create({ operation: 'health', application: 'app', params: {} });
  before.succeed(done.operationId, { ok: true });

  const restarted = new OperationStore(root); // a new Argus process
  const closed = restarted.recoverInterrupted();
  assert.deepEqual(closed.sort(), [pending.operationId, running.operationId].sort());
  for (const id of closed) {
    const r = restarted.get(id);
    assert.equal(r.status, 'failed');
    assert.match(r.error.message, /Interrupted: Argus restarted/);
    assert.ok(r.finishedAt);
  }
  assert.equal(restarted.get(running.operationId).stage, 'sync', 'keeps the stage it reached');
  assert.equal(restarted.get(done.operationId).status, 'succeeded', 'finished operations untouched');
  assert.deepEqual(restarted.recoverInterrupted(), [], 'idempotent');
  assert.match(readFileSync(join(root, 'audit.log'), 'utf8'), /operations-interrupted/);
});
