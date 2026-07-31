// Shared child-process exec primitives for built-in tools.
//
// Single home for the `promisify(execFile)` wrapper that was previously
// copy-pasted into git.mjs, process.mjs, and shell-advanced.mjs. Callers that
// need the raw rejection shape (stdout/stderr/code/signal attached on non-zero
// exit) import `execFileAsync` directly; callers that just want the
// stringified output of a successful run use `runCapped`.

import { execFile } from "node:child_process"
import { promisify } from "node:util"

/** Promisified `execFile`. Rejects with `{ stdout, stderr, code, signal, killed }`
 *  attached on non-zero exit — callers that branch on those keep using this. */
export const execFileAsync = promisify(execFile)

/**
 * Run a binary with an argv list (no shell interpolation), capped output and a
 * timeout, with `windowsHide` always set. Returns the stdout/stderr coerced to
 * strings. Throws (rejects) on non-zero exit, exactly like `execFileAsync`.
 *
 * @param {string} file Executable to run.
 * @param {ReadonlyArray<string>} args Argv list.
 * @param {{ cwd?: string, timeoutMs?: number, maxBuffer?: number }} [opts]
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
export async function runCapped(file, args, { cwd, timeoutMs, maxBuffer } = {}) {
  const { stdout, stderr } = await execFileAsync(file, args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer,
    windowsHide: true,
  })
  return { stdout: String(stdout), stderr: String(stderr) }
}
