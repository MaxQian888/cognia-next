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

// Monotonic ts watermark. `listRunEvents` orders by the [runId+ts] index, and
// for EQUAL ts IndexedDB falls back to primary-key order — a random nanoid —
// which scrambles same-millisecond events (steps appeared out of order in the
// run timeline and resume logic). The renderer is single-threaded, so a
// module-level watermark guarantees strictly increasing ts across ALL appends.
let lastTs = 0

function nextTs(): number {
  const now = Date.now()
  lastTs = now > lastTs ? now : lastTs + 1
  return lastTs
}

/** Append a single event. Use `appendEvents` for batches in a hot path. */
export async function appendEvent(input: AppendEventInput): Promise<WorkflowRunEventRow> {
  const row: WorkflowRunEventRow = {
    id: "evt_" + nanoid(10),
    runId: input.runId,
    ts: nextTs(),
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
  const rows: WorkflowRunEventRow[] = inputs.map((i) => ({
    id: "evt_" + nanoid(10),
    runId: i.runId,
    // nextTs() is strictly increasing, so input order is preserved even when
    // the whole batch lands in one millisecond.
    ts: nextTs(),
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
 * Iteration provenance attached to step events emitted from inside a loop
 * container body. Carried in the event PAYLOAD (the stepId stays the plain
 * child node id so the timeline UI groups by node); the idempotency cache
 * uses it to reconstruct per-iteration keys on resume.
 */
export interface StepIterationMeta {
  loopId: string
  iterationIndex: number
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
    stepStarted: (stepId: string, params?: unknown, meta?: StepIterationMeta) =>
      appendEvent({ runId, type: "step_started", stepId, payload: { params, ...meta } }),
    stepCompleted: (stepId: string, output: unknown, meta?: StepIterationMeta) =>
      appendEvent({ runId, type: "step_completed", stepId, payload: { output, ...meta } }),
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
