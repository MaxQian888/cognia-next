/**
 * Argv-based git / gh runner for the git-first dev commands (`/commit`, `/pr`).
 *
 * Spawns via `execFile` (no shell) so a multi-line commit message or a CJK path
 * can never be re-parsed as shell metacharacters — the same discipline the
 * sidecar git tools use (`sidecar/builtin-tools/git/run.mjs`). Every git call is
 * prefixed with `-c core.quotepath=false` (readable non-ASCII paths) and
 * `--no-optional-locks` (don't contend with a concurrent git process). The
 * spawner is injectable so the controllers unit-test without a real process.
 */
import { execFile } from "node:child_process"

/** 16 MB capture ceiling — a big diff/log truncates rather than hard-erroring. */
const MAX_BUFFER = 16 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 60_000

export interface ExecResult {
  stdout: string
  stderr: string
  /** Process exit code. `127` when the executable was not found (ENOENT). */
  code: number
}

export interface ExecOpts {
  cwd?: string
  timeoutMs?: number
}

export type ExecFn = (file: string, args: string[], opts?: ExecOpts) => Promise<ExecResult>

/** Run an executable with an argv list; never rejects — failures surface as a
 * non-zero {@link ExecResult.code} so callers branch on exit status, not throw. */
export const runExec: ExecFn = (file, args, opts = {}) =>
  new Promise<ExecResult>((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        encoding: "utf8",
      },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null
        let code = 0
        if (e) {
          if (typeof e.code === "number") code = e.code
          else if (e.code === "ENOENT") code = 127
          else code = 1
        }
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code })
      }
    )
  })

/** Run `git` with an argv list against `cwd`. Injectable exec seam for tests. */
export function runGit(args: string[], cwd: string, exec: ExecFn = runExec): Promise<ExecResult> {
  const full = ["-c", "core.quotepath=false", "--no-optional-locks", ...args]
  return exec("git", full, { cwd })
}
