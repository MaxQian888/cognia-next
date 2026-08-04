// Shared child-process exec primitives for built-in tools.
//
// Single home for the `promisify(execFile)` wrapper that was previously
// copy-pasted into git.mjs, process.mjs, and shell-advanced.mjs. Callers that
// need the raw rejection shape (stdout/stderr/code/signal attached on non-zero
// exit) import `execFileAsync` directly; callers that just want the
// stringified output of a successful run use `runCapped`.

import { execFile } from "node:child_process"

/**
 * Keep every standard stream connected when a tool child is launched.
 *
 * Git calls `sanitize_stdfds()` at startup and opens `/dev/null` when one of
 * fd 0/1/2 is missing. External ACP/MCP hosts can launch the bridge with a
 * closed descriptor, and a sandboxed macOS process may not be allowed to open
 * `/dev/null`. Explicit pipes prevent that fallback while preserving the
 * stdout/stderr capture contract used by every caller.
 */
function execFileWithPipedStdio(file, args, options, callback) {
  if (typeof options === "function") {
    callback = options
    options = {}
  }
  const normalizedOptions = options ?? {}
  return execFile(
    file,
    args,
    {
      ...normalizedOptions,
      stdio: normalizedOptions.stdio ?? ["pipe", "pipe", "pipe"],
    },
    callback
  )
}

/** Promisified `execFile`. Rejects with `{ stdout, stderr, code, signal, killed }`
 *  attached on non-zero exit — callers that branch on those keep using this. */
export function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFileWithPipedStdio(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout
        error.stderr = stderr
        reject(error)
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

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
