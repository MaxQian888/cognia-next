/**
 * Scheduled twin operations — cron-driven enqueue of ingest / distill jobs.
 *
 * The executor is intentionally narrow: it only **enqueues** a TwinJob row
 * (the job-worker running inside the workbench picks it up). This keeps the
 * cost / dependency profile small (no sidecar embed / LLM calls from the
 * scheduler) and avoids racing with the workbench's own worker.
 *
 * Task payload shape:
 *   {
 *     twinId: string                  // required
 *     kind:   "ingest" | "distill" | "re-distill"   // defaults to "distill"
 *     sourceIds?: string[]            // optional ingest scope; empty/missing
 *                                     // = "every pending source"
 *   }
 */

import { enqueueDistillJob } from "@/lib/twin/distill"
import { enqueueIngestJob } from "@/lib/twin/ingest"
import { listTwinSourcesByTwinAndStatus } from "@/lib/db/twin-sources"
import type { ScheduledTask, TaskExecution } from "@/types/scheduler"
import { loggers } from "@/lib/logger"

const log = loggers.scheduler

interface TwinTaskPayload {
  twinId?: string
  kind?: "ingest" | "distill" | "re-distill"
  sourceIds?: string[]
}

interface TwinTaskResult {
  success: boolean
  output?: Record<string, unknown>
  error?: string
}

export async function executeTwinTask(
  task: ScheduledTask,
  execution: TaskExecution,
  _signal: AbortSignal
): Promise<TwinTaskResult> {
  const payload = (task.payload ?? {}) as TwinTaskPayload
  if (!payload.twinId) {
    return { success: false, error: "twin task requires `twinId` in payload" }
  }
  const kind = payload.kind ?? "distill"

  try {
    if (kind === "ingest") {
      const pendingIds =
        payload.sourceIds && payload.sourceIds.length > 0
          ? payload.sourceIds
          : (await listTwinSourcesByTwinAndStatus(payload.twinId, "pending")).map((s) => s.id)
      if (pendingIds.length === 0) {
        log.info("Scheduler twin task: no pending sources to ingest, skipping enqueue", {
          taskId: task.id,
          executionId: execution.id,
          twinId: payload.twinId,
        })
        return { success: true, output: { skipped: "no pending sources" } }
      }
      const job = await enqueueIngestJob({ twinId: payload.twinId, sourceIds: pendingIds })
      return {
        success: true,
        output: { enqueuedJobId: job.id, sourceCount: pendingIds.length, kind },
      }
    }

    const job = await enqueueDistillJob(payload.twinId, {
      reDistill: kind === "re-distill",
    })
    return {
      success: true,
      output: { enqueuedJobId: job.id, kind },
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}
