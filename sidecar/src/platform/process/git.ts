// `git` with an argv list: no shell interpolation, so an argument can never be
// re-parsed as shell metacharacters. Shared by the git tools and the
// dependency-research clone.

import { runCapped } from "./exec.ts"

// The child may BUFFER far more than we DISPLAY. Keeping the execFile maxBuffer
// equal to the display cap meant any command over 256 KB (a large diff/log)
// rejected with "maxBuffer exceeded" before trimTail could turn it into a
// useful truncated preview. Capture up to 16 MB, then trimTail caps the
// model-facing slice — so overflow degrades to a truncation, not a hard error.
export const MAX_CAPTURE_BYTES = 16 * 1024 * 1024
export const DEFAULT_TIMEOUT_MS = 30 * 1000

export interface GitOutput {
  stdout: string
  stderr: string
}

export type GitRunner = (args: readonly string[], cwd: string) => Promise<GitOutput>

/** Run `git` with an argv list, capped output, stdout/stderr as strings. */
export async function runGit(
  args: readonly unknown[],
  cwd: string,
  opts: { timeoutMs?: number } = {}
): Promise<GitOutput> {
  if (!Array.isArray(args)) throw new Error("git args must be an array")
  for (const a of args) {
    if (typeof a !== "string") throw new Error("every git arg must be a string")
  }
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  // Repo-wide config applied to every git invocation:
  //   core.quotepath=false — emit non-ASCII paths (CJK, accented) verbatim
  //     instead of octal-escaped ("\346\265\213…"), so status/diff/log output
  //     is readable for the model and the user.
  //   --no-optional-locks — read-only commands (status, diff) won't take the
  //     index lock, avoiding contention with a concurrent git process.
  const fullArgs = ["-c", "core.quotepath=false", "--no-optional-locks", ...(args as string[])]
  return runCapped("git", fullArgs, { cwd, timeoutMs: timeout, maxBuffer: MAX_CAPTURE_BYTES })
}
