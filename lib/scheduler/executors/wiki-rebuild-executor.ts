// Cron-driven External Bridge wiki rebuild executor.
//
// Pairs with the schedule UI in
// `components/settings/external-bridge/wiki-rebuild-card.tsx`: the UI creates
// one `wiki-rebuild` task with `payload.force?: boolean`; this executor runs
// `runWikiRebuild({ force })` on each fire, surfaces the result via the
// scheduler's `output` / `error` channel, and lets `HostFilesystemError` /
// `NoApiKeyError` propagate as terminal failures with a clear message so the
// next Run-now retry has actionable context.
//
// Host gate: the rebuild walks the host filesystem, so it needs the
// `host-filesystem` requirement (desktop or headless brain) — decided by
// `lib/scheduler/host-support.ts`, not by an `isTauri()` branch.

import type {
  ScheduledTask,
  TaskExecution,
  TaskExecutorResult,
  WikiRebuildTaskPayload,
} from "@/types/scheduler"
import { runWikiRebuild, HostFilesystemError, NoApiKeyError } from "@/lib/wiki/rebuild-runner"
import { assertTaskTypeSupportedOnHost } from "../host-support"
import { loggers } from "@cognia/logging"

const log = loggers.scheduler

type ExecutorResult = TaskExecutorResult

export async function executeWikiRebuildTask(
  task: ScheduledTask,
  execution: TaskExecution,
  _signal: AbortSignal
): Promise<ExecutorResult> {
  const refused = assertTaskTypeSupportedOnHost(task.type)
  if (refused) return refused

  const payload = (task.payload ?? {}) as Partial<WikiRebuildTaskPayload>
  const force = payload.force === true
  const rootDir =
    typeof payload.rootDir === "string" && payload.rootDir.trim().length > 0
      ? payload.rootDir.trim()
      : undefined

  try {
    const result = await runWikiRebuild({ force, rootDir })
    log.info("Scheduler wiki-rebuild task complete", {
      taskId: task.id,
      executionId: execution.id,
      added: result.added,
      changed: result.changed,
      removed: result.removed,
      errors: result.errors.length,
      durationMs: result.durationMs,
    })
    return {
      success: true,
      output: {
        added: result.added,
        changed: result.changed,
        removed: result.removed,
        unchanged: result.unchanged,
        errors: result.errors.length,
        durationMs: result.durationMs,
      },
    }
  } catch (err) {
    let error: string
    if (err instanceof HostFilesystemError) {
      error = "Wiki rebuild requires a host with filesystem access (desktop app or cloud host)."
    } else if (err instanceof NoApiKeyError) {
      error = "No LLM API key configured — add one in Settings → Providers."
    } else {
      error = err instanceof Error ? err.message : String(err)
    }
    log.error("Scheduler wiki-rebuild task failed", { taskId: task.id, error })
    return { success: false, error }
  }
}
