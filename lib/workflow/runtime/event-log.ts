/**
 * Run event log — the durable per-step record that the editor + Runs UI
 * read live via `useLiveQuery`. Append-only writer over `workflowRunEvents`,
 * with a small batching wrapper so the orchestrator can emit many events
 * in a row without producing N separate Dexie transactions.
 */

import { nanoid } from "nanoid"
import { getDb } from "@/lib/db/schema"
import type { RunEventLogLevel, RunEventType, WorkflowRunEventRow } from "@/types/workflow/visual"

export interface AppendEventInput {
  runId: string
  type: RunEventType
  stepId?: string
  level?: RunEventLogLevel
  payload?: unknown
}

/** Append a single event. Use `appendEvents` for batches in a hot path. */
export async function appendEvent(input: AppendEventInput): Promise<WorkflowRunEventRow> {
  const row: WorkflowRunEventRow = {
    id: "evt_" + nanoid(10),
    runId: input.runId,
    ts: Date.now(),
    type: input.type,
    stepId: input.stepId,
    level: input.level,
    payload: input.payload,
  }
  await getDb().workflowRunEvents.put(row)
  return row
}

/** Append many events in a single transaction. Preserves the input order. */
export async function appendEvents(inputs: AppendEventInput[]): Promise<void> {
  if (inputs.length === 0) return
  const now = Date.now()
  const rows: WorkflowRunEventRow[] = inputs.map((i, idx) => ({
    id: "evt_" + nanoid(10),
    runId: i.runId,
    // Bump ts by index so two events appended in the same ms still sort.
    ts: now + idx,
    type: i.type,
    stepId: i.stepId,
    level: i.level,
    payload: i.payload,
  }))
  await getDb().workflowRunEvents.bulkPut(rows)
}

/**
 * Return all events for a run, in time order. Used by the run timeline view
 * AND by the orchestrator's resume path to compute "what's already done?".
 */
export async function listRunEvents(runId: string): Promise<WorkflowRunEventRow[]> {
  return getDb()
    .workflowRunEvents.where("[runId+ts]")
    .between([runId, 0], [runId, Number.MAX_SAFE_INTEGER])
    .toArray()
}

/**
 * Return the set of step ids that have completed successfully for `runId`.
 * Used by `resumeFromEventLog` to skip re-execution after a crash.
 */
export async function completedStepIds(runId: string): Promise<Set<string>> {
  const events = await getDb()
    .workflowRunEvents.where("[runId+stepId]")
    .between([runId, ""], [runId, "￿"])
    .filter((e) => e.type === "step_completed" && !!e.stepId)
    .toArray()
  return new Set(events.map((e) => e.stepId as string))
}

/**
 * Convenience scoped logger — captures runId once so nodes don't re-pass it.
 */
export function createRunLogger(runId: string) {
  return {
    runStarted: (payload?: unknown) => appendEvent({ runId, type: "run_started", payload }),
    runCompleted: (output?: unknown) =>
      appendEvent({ runId, type: "run_completed", payload: output }),
    runFailed: (error: { message: string; stack?: string; nodeId?: string }) =>
      appendEvent({
        runId,
        type: "run_failed",
        level: "error",
        payload: error,
      }),
    runCancelled: () => appendEvent({ runId, type: "run_cancelled" }),
    stepStarted: (stepId: string, params?: unknown) =>
      appendEvent({ runId, type: "step_started", stepId, payload: { params } }),
    stepCompleted: (stepId: string, output: unknown) =>
      appendEvent({ runId, type: "step_completed", stepId, payload: { output } }),
    stepFailed: (stepId: string, error: { message: string; retryable?: boolean }) =>
      appendEvent({
        runId,
        type: "step_failed",
        level: "error",
        stepId,
        payload: error,
      }),
    stepSkipped: (stepId: string, reason: string) =>
      appendEvent({
        runId,
        type: "step_skipped",
        stepId,
        payload: { reason },
      }),
    log: (level: RunEventLogLevel, message: string, payload?: unknown, stepId?: string) =>
      appendEvent({
        runId,
        type: "run_log",
        level,
        stepId,
        payload: { message, data: payload },
      }),
  }
}

export type RunLogger = ReturnType<typeof createRunLogger>
