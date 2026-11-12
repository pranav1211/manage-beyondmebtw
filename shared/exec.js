// Safe process runner for Argus. Fixed argv via execFile — NEVER a shell, never
// caller-supplied command text. Non-zero exits are returned (not thrown) so
// callers can branch on git's exit-code conventions (e.g. `diff --quiet`).

import { execFile } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * @param {string} file executable (fixed by Argus code, e.g. 'git')
 * @param {string[]} args argument vector
 * @param {object} [opts] { cwd, timeout, env }
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
export function run(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeout ?? DEFAULT_TIMEOUT_MS,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(opts.env || {}) },
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        shell: false
      },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || '') });
      }
    );
  });
}

// Trim command output for records/logs: last N chars, no secret-bearing env.
export function tail(text, n = 600) {
  const s = String(text || '').trim();
  return s.length > n ? `…${s.slice(-n)}` : s;
}
