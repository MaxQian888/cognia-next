// Cron-driven wiki-lint executor.
//
// Pairs with the schedule UI in
// `components/settings/external-bridge/wiki-lint-card.tsx`: the UI creates one
// `wiki-lint` task; this executor runs `runWikiLint("cognia-self")` on each
// fire and surfaces the finding counts via the scheduler's `output` channel.
//
// Unlike wiki-rebuild this is not Tauri-gated — the lint pass reads only Dexie.

import type { ScheduledTask, TaskExecution } from "@/types/scheduler"
import { runWikiLint } from "@/lib/wiki/lint/lint-runner"
import { loggers } from "@/lib/logging"

const log = loggers.scheduler

interface ExecutorResult {
  success: boolean
  output?: Record<string, unknown>
  error?: string
}

export async function executeWikiLintTask(
  task: ScheduledTask,
  execution: TaskExecution,
  _signal: AbortSignal
): Promise<ExecutorResult> {
  try {
    const result = await runWikiLint("cognia-self")
    log.info("Scheduler wiki-lint task complete", {
      taskId: task.id,
      executionId: execution.id,
      articleCount: result.articleCount,
      broken: result.brokenLinks.length,
      orphans: result.orphans.length,
    })
    return {
      success: true,
      output: {
        articleCount: result.articleCount,
        brokenLinks: result.brokenLinks.length,
        orphans: result.orphans.length,
      },
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    log.error("Scheduler wiki-lint task failed", { taskId: task.id, error })
    return { success: false, error }
  }
}
