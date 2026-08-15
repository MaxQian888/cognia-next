/**
 * `test` scheduled-task executor.
 *
 * A deliberately side-effect-free executor that proves the whole trigger →
 * arm → fire → execute → notify chain works on the current host without
 * touching any external system. Useful when bringing up a new host (headless
 * brain, a fresh desktop) or when a user wants to verify a cron expression /
 * notification channel before pointing a real workload at it.
 *
 *   payload.echo     → copied verbatim into `output.echo`
 *   payload.delayMs  → abortable sleep before completion (bounded to the task
 *                      timeout by the scheduler; capped here at 1h defensively)
 *   payload.failWith → when set, the run fails with that message so error
 *                      notifications / retry policies can be exercised
 *
 * Runs on every host — it declares no host requirement in
 * `TASK_TYPE_HOST_REQUIREMENTS`.
 */

import type {
  ScheduledTask,
  TaskExecution,
  TaskExecutorResult,
  TestTaskPayload,
} from "@/types/scheduler"
import { detectPlatform } from "@/lib/platform/detect"
import { loggers } from "@cognia/logging"

const log = loggers.scheduler

/** Upper bound for `delayMs` so a typo cannot park an execution for days. */
export const TEST_TASK_MAX_DELAY_MS = 60 * 60 * 1000

function normalizeDelay(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0
  return Math.min(Math.floor(value), TEST_TASK_MAX_DELAY_MS)
}

/** Sleep that resolves early (rejecting) when `signal` aborts. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error("aborted"))
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

export async function executeTestTask(
  task: ScheduledTask,
  execution: TaskExecution,
  signal: AbortSignal
): Promise<TaskExecutorResult> {
  const payload = (task.payload ?? {}) as Partial<TestTaskPayload>
  const startedAt = Date.now()
  const delayMs = normalizeDelay(payload.delayMs)

  if (signal.aborted) {
    return { success: false, error: "Test task aborted before start" }
  }

  try {
    await abortableSleep(delayMs, signal)
  } catch {
    return { success: false, error: "Test task was cancelled while sleeping" }
  }

  const output: Record<string, unknown> = {
    echo: payload.echo ?? null,
    delayMs,
    platform: detectPlatform(),
    triggerSource: execution.triggerSource ?? null,
    scheduledFor: execution.scheduledFor ? execution.scheduledFor.toISOString() : null,
    firedAt: new Date(startedAt).toISOString(),
    elapsedMs: Date.now() - startedAt,
  }

  if (typeof payload.failWith === "string" && payload.failWith.trim().length > 0) {
    log.info("Scheduler test task failing on request", {
      taskId: task.id,
      executionId: execution.id,
    })
    return { success: false, output, error: payload.failWith }
  }

  log.info("Scheduler test task complete", { taskId: task.id, executionId: execution.id })
  return { success: true, output }
}
