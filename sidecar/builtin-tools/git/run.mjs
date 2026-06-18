// Git command runner + shared guards.
//
// Each git tool spawns `git` via execFile (no shell interpolation) so args can
// never be re-parsed as shell metacharacters. `assertRepo` validates the repo
// root upfront; `trimTail` caps output (a thin alias over the shared
// head-truncate primitive so all output-capping behaviour lives in one place).

import { runCapped } from "../shared/exec.mjs"
import { headTruncate } from "../shared/truncate.mjs"

export const MAX_OUTPUT_BYTES = 256 * 1024 // 256 KB per command
export const DEFAULT_TIMEOUT_MS = 30 * 1000

/**
 * Run `git` with an argv list, capped output, stdout/stderr as strings.
 * @param {ReadonlyArray<string>} args
 * @param {string} cwd
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
export async function runGit(args, cwd, opts = {}) {
  if (!Array.isArray(args)) throw new Error("git args must be an array")
  for (const a of args) {
    if (typeof a !== "string") throw new Error("every git arg must be a string")
  }
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return runCapped("git", args, { cwd, timeoutMs: timeout, maxBuffer: MAX_OUTPUT_BYTES })
}

/** Throw unless `cwd` is inside a git repository. */
export async function assertRepo(cwd) {
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new Error("cwd must be a non-empty absolute path")
  }
  try {
    await runGit(["rev-parse", "--git-dir"], cwd)
  } catch (err) {
    throw new Error(`not a git repository: ${cwd} (${err.message})`)
  }
}

/** Cap output, keeping the head + a "... (truncated)" marker. */
export function trimTail(s, max = MAX_OUTPUT_BYTES) {
  return headTruncate(s, max)
}
