/**
 * Keeps the background GitHub-mirror refresh in step with reality.
 *
 * A registered executor with no task row that fires it is the repo's most
 * recurrent defect (built, correct, unreachable). So the schedule is
 * reconciled from the only fact that matters — whether ANY workspace has a
 * `github-repo` resource bound:
 *
 *   at least one binding → a single `github-issue-sync::singleton` row
 *   no bindings          → no row at all
 *
 * Ties the task's existence to the moment it becomes meaningful, so an install
 * that never touches GitHub carries no recurring work, and a user who binds
 * their first repo does not have to discover a settings toggle to make the
 * board stay fresh.
 *
 * Shape and reconcile semantics are lifted from
 * `lib/wiki/lint/lint-cron-bridge.ts` — same singleton-row pattern, same
 * create/update/delete verdicts.
 */

import { schedulerDb } from "@/lib/scheduler/scheduler-db"
import type { ScheduledTask, TaskExecutionConfig, TaskNotificationConfig } from "@/types/scheduler"
import { resolveWorkspaceGithubBindings } from "./sync-runner"

export const GITHUB_ISSUE_SYNC_TASK_ID = "github-issue-sync::singleton"

/**
 * 15 minutes. GitHub's authenticated budget is 5000 requests/hour and a sync
 * that finds nothing new costs one conditional request per repo, so this is
 * inexpensive even with a dozen repos bound.
 */
export const GITHUB_ISSUE_SYNC_INTERVAL_MS = 15 * 60_000

function defaultConfig(): TaskExecutionConfig {
  return {
    timeout: 5 * 60_000,
    maxRetries: 1,
    retryDelay: 60_000,
    maxRetryDelay: 10 * 60_000,
    // The watermark makes the next run cover any window this one missed, so
    // replaying on startup would only re-spend rate-limit budget. Mirrors the
    // `never` catch-up tier in `lib/scheduler/catchup-policy.ts`.
    runMissedOnStartup: false,
    allowConcurrent: false,
  }
}

function defaultNotification(): TaskNotificationConfig {
  // A background cache refresh that succeeded is not news. A failing one is:
  // it means the board has quietly gone stale.
  return { onStart: false, onComplete: false, onError: true }
}

function buildTask(existing: ScheduledTask | null): ScheduledTask {
  const now = new Date()
  return {
    id: GITHUB_ISSUE_SYNC_TASK_ID,
    name: "Issues — GitHub mirror refresh",
    description: "Incremental refresh of the GitHub issues mirrored onto the issue board.",
    type: "github-issue-sync",
    trigger: {
      type: "interval",
      intervalMs: GITHUB_ISSUE_SYNC_INTERVAL_MS,
      // Every install fires this on the same cadence; jitter keeps them from
      // arriving at GitHub's edge together.
      jitterMs: 60_000,
    },
    // No `projectId`: one task sweeps every workspace's bindings, so switching
    // workspaces never leaves a board refreshing against a stale schedule.
    payload: {},
    config: existing?.config ?? defaultConfig(),
    notification: existing?.notification ?? defaultNotification(),
    status: "active",
    tags: existing?.tags ?? ["issues", "github", "sync"],
    runCount: existing?.runCount ?? 0,
    successCount: existing?.successCount ?? 0,
    failureCount: existing?.failureCount ?? 0,
    lastError: existing?.lastError,
    lastRunAt: existing?.lastRunAt,
    nextRunAt: existing?.nextRunAt,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
}

export interface SyncGithubIssueScheduleResult {
  action: "created" | "kept" | "deleted" | "skipped"
  bindingCount: number
}

/**
 * Reconcile the singleton row against the current bindings. Idempotent — safe
 * to call on boot, after adding a resource, and after removing one.
 */
export async function syncGithubIssueSchedule(): Promise<SyncGithubIssueScheduleResult> {
  const bindings = await resolveWorkspaceGithubBindings()
  const existing = await schedulerDb.getTask(GITHUB_ISSUE_SYNC_TASK_ID)

  if (bindings.length === 0) {
    if (existing) {
      await schedulerDb.deleteTask(GITHUB_ISSUE_SYNC_TASK_ID)
      return { action: "deleted", bindingCount: 0 }
    }
    return { action: "skipped", bindingCount: 0 }
  }

  if (existing) {
    // Deliberately NOT an update: rewriting the row on every resource change
    // would reset a cadence the user may have retuned in the scheduler UI, and
    // would restart the interval clock each time.
    return { action: "kept", bindingCount: bindings.length }
  }

  await schedulerDb.createTask(buildTask(null))
  return { action: "created", bindingCount: bindings.length }
}
