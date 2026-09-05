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
import { isMissingGithubCredential } from "@/lib/issues/sync-runner"
import { runWorkspaceIssueSync } from "@/lib/issues/sync/runner"
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
    // One entry point for the mirror AND every import/Lark/plugin binding
    // (spec 2026-09-06 D1), so the schedule can never drift from "Sync now".
    const sync = await runWorkspaceIssueSync(readPayload(task))
    const result = sync.mirror

    const written = result.results.reduce((sum, repo) => sum + repo.written, 0)
    const notModified = result.results.filter((repo) => repo.notModified).length
    const truncated = result.results.filter((repo) => repo.truncated).length
    const failures = [
      ...result.failures.map((failure) => ({ name: failure.repoFullName, error: failure.error })),
      ...sync.failures.map((failure) => ({ name: failure.binding.key, error: failure.error })),
    ]
    // Distinguished from a plain failure so the UI can say "connect GitHub"
    // rather than "sync failed", which sends the user hunting for the wrong bug.
    const unauthorized = failures.filter((failure) =>
      isMissingGithubCredential(failure.error)
    ).length
    const imported = sync.outcomes.reduce((sum, outcome) => sum + outcome.created, 0)
    const updated = sync.outcomes.reduce((sum, outcome) => sum + outcome.updated, 0)
    const pushed = sync.outcomes.reduce((sum, outcome) => sum + outcome.pushed, 0)
    const queued = sync.outcomes.reduce((sum, outcome) => sum + outcome.queued, 0)
    const conflicts = sync.outcomes.reduce((sum, outcome) => sum + outcome.conflicts, 0)

    log.info("Scheduler github-issue-sync complete", {
      taskId: task.id,
      executionId: execution.id,
      bindingCount: sync.bindingCount,
      written,
      notModified,
      imported,
      updated,
      pushed,
      queued,
      conflicts,
      failures: failures.length,
    })

    // A binding that failed is a failed execution, otherwise a revoked token
    // looks like a healthy 15-minute cadence forever. Bindings that DID sync
    // keep their rows regardless: both runners isolate each one.
    return {
      success: failures.length === 0,
      output: {
        repoCount: result.repoCount,
        bindingCount: sync.bindingCount,
        written,
        notModified,
        truncated,
        unauthorized,
        imported,
        updated,
        pushed,
        queued,
        conflicts,
        failedRepos: failures.map((failure) => failure.name),
      },
      ...(failures.length > 0
        ? {
            error: `${failures.length} binding(s) failed to sync: ${failures
              .map((failure) => failure.name)
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
