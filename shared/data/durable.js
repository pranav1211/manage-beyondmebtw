// Durable file primitives for canonical data and runtime state.
//
// writeDurable: write to a temp file in the SAME directory, fsync it, rename
// over the target (atomic on POSIX and NTFS), then fsync the directory where the
// platform allows it. A crash leaves either the old or the new file, never a
// partial one. Text is normalized to LF so hashes are platform-independent.

import { openSync, writeSync, fsyncSync, closeSync, renameSync, mkdirSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

export const normalizeText = (s) => String(s).replace(/\r\n/g, '\n');
export const sha256 = (s) => createHash('sha256').update(normalizeText(s)).digest('hex');

export function fsyncDir(dir) {
  // Directory fsync is not supported on Windows; it is best-effort there.
  let fd;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch {
    /* unsupported on this platform */
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
}

export function tempPathFor(target) {
  return join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
}

/** Atomically replace `target` with `content` (LF-normalized). Returns its sha256. */
export function writeDurable(target, content) {
  const text = normalizeText(content);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = tempPathFor(target);
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, target);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
  fsyncDir(dirname(target));
  return sha256(text);
}

/** File content (LF-normalized) or null when absent. */
export function readTextOrNull(path) {
  if (!existsSync(path)) return null;
  return normalizeText(readFileSync(path, 'utf8'));
}

export function hashOrNull(path) {
  const t = readTextOrNull(path);
  return t === null ? null : sha256(t);
}

export function removeDurable(target) {
  if (existsSync(target)) {
    unlinkSync(target);
    fsyncDir(dirname(target));
  }
}
