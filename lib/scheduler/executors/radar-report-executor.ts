// Cron-driven Attention Radar executor.
//
// Pairs with the settings card in `components/settings/radar/radar-card.tsx`:
// the card creates one `radar-report` task; this executor runs
// `runRadarReport()` on each fire (respecting the interval guard unless the
// report is due) and surfaces the outcome. Not Tauri-gated — it reads Dexie +
// a renderer-side LLM client, both of which exist in web mode too.

import type { ScheduledTask, TaskExecution } from "@/types/scheduler"
import { runRadarReport, NoRadarModelError } from "@/lib/radar/radar-runner"
import { loggers } from "@cognia/logging"

const log = loggers.scheduler

interface ExecutorResult {
  success: boolean
  output?: Record<string, unknown>
  error?: string
}

export async function executeRadarReportTask(
  task: ScheduledTask,
  execution: TaskExecution,
  _signal: AbortSignal
): Promise<ExecutorResult> {
  try {
    const report = await runRadarReport()
    if (!report) {
      log.info("Scheduler radar-report skipped (guard)", {
        taskId: task.id,
        executionId: execution.id,
      })
      return { success: true, output: { skipped: true } }
    }
    log.info("Scheduler radar-report complete", {
      taskId: task.id,
      executionId: execution.id,
      itemCount: report.itemCount,
    })
    return { success: true, output: { itemCount: report.itemCount, reportId: report.id } }
  } catch (err) {
    const error =
      err instanceof NoRadarModelError
        ? "No LLM API key configured — add one in Settings → Providers."
        : err instanceof Error
          ? err.message
          : String(err)
    log.error("Scheduler radar-report failed", { taskId: task.id, error })
    return { success: false, error }
  }
}
