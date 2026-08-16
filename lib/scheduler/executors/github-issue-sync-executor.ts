// Cron-driven GitHub issue mirror refresh.
//
// Pairs with the "Sync now" button in `components/issues/project-console.tsx`:
// both call `runWorkspaceGithubSync`, so a schedule can never drift from the
// manual path. The board itself never calls the network — it reads the Dexie
// mirror this executor fills, which is why an expired token degrades to
// stale-but-visible instead of a blank board.
//
// Payload is optional. With no `projectId` it sweeps every bound repo across
// every workspace, which is the right granularity for one background task per
// install; pass `projectId` to schedule a single workspace instead.
//
// Not Tauri-gated: the read goes through the WebView's fetch (the CSP now
// whitelists api.github.com), so this runs in the browser shell too.

import type { ScheduledTask, TaskExecution } from "@/types/scheduler"
import { isMissingGithubCredential, runWorkspaceGithubSync } from "@/lib/issues/sync-runner"
import { loggers } from "@cognia/logging"

const log = loggers.scheduler

interface ExecutorResult {
  success: boolean
  output?: Record<string, unknown>
  error?: string
}

/** Payload fields this executor understands. Anything else is ignored. */
export interface GithubIssueSyncTaskPayload {
  projectId?: string
  full?: boolean
}

function readPayload(task: ScheduledTask): GithubIssueSyncTaskPayload {
  const payload = (task.payload ?? {}) as Record<string, unknown>
  return {
    ...(typeof payload.projectId === "string" ? { projectId: payload.projectId } : {}),
    ...(payload.full === true ? { full: true } : {}),
  }
}

export async function executeGithubIssueSyncTask(
  task: ScheduledTask,
  execution: TaskExecution,
  _signal: AbortSignal
): Promise<ExecutorResult> {
  try {
    const result = await runWorkspaceGithubSync(readPayload(task))

    const written = result.results.reduce((sum, repo) => sum + repo.written, 0)
    const notModified = result.results.filter((repo) => repo.notModified).length
    const truncated = result.results.filter((repo) => repo.truncated).length
    // Distinguished from a plain failure so the UI can say "connect GitHub"
    // rather than "sync failed", which sends the user hunting for the wrong bug.
    const unauthorized = result.failures.filter((failure) =>
      isMissingGithubCredential(failure.error)
    ).length

    log.info("Scheduler github-issue-sync complete", {
      taskId: task.id,
      executionId: execution.id,
      repoCount: result.repoCount,
      written,
      notModified,
      failures: result.failures.length,
    })

    // A repo that failed is a failed execution — otherwise a revoked token
    // looks like a healthy 15-minute cadence forever. Repos that DID sync keep
    // their rows regardless; `syncWorkspaceRepos` isolates each one.
    return {
      success: result.failures.length === 0,
      output: {
        repoCount: result.repoCount,
        written,
        notModified,
        truncated,
        unauthorized,
        failedRepos: result.failures.map((failure) => failure.repoFullName),
      },
      ...(result.failures.length > 0
        ? {
            error: `${result.failures.length} repo(s) failed to sync: ${result.failures
              .map((failure) => failure.repoFullName)
              .join(", ")}`,
          }
        : {}),
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    log.error("Scheduler github-issue-sync failed", { taskId: task.id, error })
    return { success: false, error }
  }
}
