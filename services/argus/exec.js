// Re-export: the safe process runner lives in shared/ so both Argus and the
// Config Repo adapter use the same no-shell execFile wrapper.
export * from '../../shared/exec.js';
