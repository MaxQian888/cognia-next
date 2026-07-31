// Cron-driven External Bridge wiki rebuild executor.
//
// Pairs with the schedule UI in
// `components/settings/external-bridge/wiki-rebuild-card.tsx`: the UI creates
// one `wiki-rebuild` task with `payload.force?: boolean`; this executor runs
// `runWikiRebuild({ force })` on each fire, surfaces the result via the
// scheduler's `output` / `error` channel, and lets `WebModeError` /
// `NoApiKeyError` propagate as terminal failures with a clear message so the
// next Run-now retry has actionable context.
//
// Tauri-only: web-mode runs return a clear error rather than spinning the
// CPU on a no-op orchestrator.

import type { ScheduledTask, TaskExecution, WikiRebuildTaskPayload } from "@/types/scheduler"
import { runWikiRebuild, WebModeError, NoApiKeyError } from "@/lib/wiki/rebuild-runner"
import { isTauri } from "@/lib/tauri"
import { loggers } from "@cognia/logging"

const log = loggers.scheduler

interface ExecutorResult {
  success: boolean
  output?: Record<string, unknown>
  error?: string
}

export async function executeWikiRebuildTask(
  task: ScheduledTask,
  execution: TaskExecution,
  _signal: AbortSignal
): Promise<ExecutorResult> {
  if (!isTauri()) {
    const error =
      "Scheduled wiki rebuild requires the Tauri runtime — open the desktop app to enable."
    return { success: false, error }
  }

  const payload = (task.payload ?? {}) as Partial<WikiRebuildTaskPayload>
  const force = payload.force === true

  try {
    const result = await runWikiRebuild({ force })
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
    if (err instanceof WebModeError) {
      error = "Wiki rebuild requires the Tauri desktop app."
    } else if (err instanceof NoApiKeyError) {
      error = "No LLM API key configured — add one in Settings → Providers."
    } else {
      error = err instanceof Error ? err.message : String(err)
    }
    log.error("Scheduler wiki-rebuild task failed", { taskId: task.id, error })
    return { success: false, error }
  }
}
