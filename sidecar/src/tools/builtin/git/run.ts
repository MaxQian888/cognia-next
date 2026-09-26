// Shared guards for the git tools. The argv runner itself is
// `platform/process/git.ts`, which the dependency-research category shares.
// `assertRepo` validates the repo root upfront; `trimTail` caps output (a thin
// alias over the shared head-truncate primitive so all output-capping
// behaviour lives in one place).

import { runGit } from "../../../platform/process/git.ts"
import type { GitRunner } from "../../../platform/process/git.ts"
import { headTruncate } from "../../../shared/text/truncate.ts"

export const MAX_OUTPUT_BYTES = 256 * 1024 // 256 KB display cap (trimTail)
// Every git tool calls `assertRepo` before its real command — a second `git`
// subprocess per call. A cwd's repo-membership doesn't change within a session,
// so a successful validation is memoized (failures are not cached — a freshly
// `git init`-ed cwd must be retried). Cache is keyed by cwd string.
const validatedRepos = new Set<string>()

/** Drop the repo-validation cache (tests). */
export function resetRepoCache(): void {
  validatedRepos.clear()
}

/** Throw unless `cwd` is inside a git repository. */
export async function assertRepo(cwd: unknown, runner: GitRunner = runGit): Promise<void> {
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new Error("cwd must be a non-empty absolute path")
  }
  if (validatedRepos.has(cwd)) return
  try {
    await runner(["rev-parse", "--git-dir"], cwd)
  } catch (err) {
    const detail = String((err as { message?: unknown } | null)?.message ?? err)
    if (/not a git repository|not a git work tree/i.test(detail)) {
      throw new Error(`not a git repository: ${cwd} (${detail})`)
    }
    throw new Error(
      `git subprocess health check failed for ${cwd}: ${detail}. ` +
        "The Cognia Tools host may have stale or invalid stdio/temp permissions; restart the sidecar and retry."
    )
  }
  validatedRepos.add(cwd)
}

/** Cap output, keeping the head + a "... (truncated)" marker. */
export function trimTail(s: string, max: number = MAX_OUTPUT_BYTES) {
  return headTruncate(s, max)
}
