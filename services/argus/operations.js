// Operation records + deployed-state store. Local operational state under the
// Argus state root (logs area) — NOT canonical Manage data and NOT Git-backed.
// Every record is validated against operation-record.schema.json and written
// atomically (tmp + rename). Records are sanitized: no secrets, no stacks.

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, appendFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AppError, sanitizeError } from '../../shared/errors.js';
import { validateOperationRecord } from '../../shared/schemas/index.js';

function atomicWriteJson(path, obj) {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  renameSync(tmp, path);
}

export function newOperationId() {
  return `op_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
}

export class OperationStore {
  constructor(stateRoot) {
    this.root = resolve(stateRoot);
    this.opsDir = join(this.root, 'operations');
    this.deployedPath = join(this.root, 'deployed.json');
    this.auditPath = join(this.root, 'audit.log');
    mkdirSync(this.opsDir, { recursive: true });
  }

  #path(id) {
    if (!/^op_[a-z0-9]+_[0-9a-f]{8}$/.test(id)) throw new AppError('VALIDATION_FAILED', 'Invalid operation id');
    return join(this.opsDir, `${id}.json`);
  }

  create({ operation, application, params }) {
    const record = {
      schemaVersion: 1,
      operationId: newOperationId(),
      operation,
      application,
      status: 'pending',
      stage: null,
      createdAt: new Date().toISOString(),
      finishedAt: null,
      result: params ? { params } : null,
      error: null
    };
    this.#write(record);
    return record;
  }

  update(id, patch) {
    const current = this.get(id);
    if (!current) throw new AppError('RESOURCE_NOT_FOUND', 'Operation not found');
    const next = { ...current, ...patch };
    if (patch.result && current.result) next.result = { ...current.result, ...patch.result };
    this.#write(next);
    return next;
  }

  stage(id, stage) {
    return this.update(id, { status: 'running', stage });
  }

  succeed(id, result) {
    return this.update(id, { status: 'succeeded', finishedAt: new Date().toISOString(), result });
  }

  fail(id, stage, err, result) {
    return this.update(id, {
      status: 'failed',
      stage,
      finishedAt: new Date().toISOString(),
      error: sanitizeError(err),
      ...(result ? { result } : {})
    });
  }

  block(id, code, message, result) {
    return this.update(id, {
      status: 'blocked',
      finishedAt: new Date().toISOString(),
      error: { code, message },
      ...(result ? { result } : {})
    });
  }

  get(id) {
    const p = this.#path(id);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf8'));
  }

  list() {
    return readdirSync(this.opsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(this.opsDir, f), 'utf8')))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  #write(record) {
    const { valid, errors } = validateOperationRecord(record);
    if (!valid) throw new AppError('INTERNAL', 'Operation record failed validation', { errors });
    atomicWriteJson(this.#path(record.operationId), record);
  }

  // ── Deployed state (idempotency) ──
  getDeployed(application) {
    if (!existsSync(this.deployedPath)) return null;
    const all = JSON.parse(readFileSync(this.deployedPath, 'utf8'));
    return all[application] || null;
  }

  setDeployed(application, state) {
    const all = existsSync(this.deployedPath) ? JSON.parse(readFileSync(this.deployedPath, 'utf8')) : {};
    all[application] = { ...state, at: new Date().toISOString() };
    atomicWriteJson(this.deployedPath, all);
  }

  // Audit trail for requests that were rejected before an operation existed.
  audit(entry) {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
    appendFileSync(this.auditPath, line + '\n');
  }
}
