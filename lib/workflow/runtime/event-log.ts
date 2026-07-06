/**
 * Run event log — the durable per-step record that the editor + Runs UI
 * read live via `useLiveQuery`. Append-only writer over `workflowRunEvents`,
 * with a small batching wrapper so the orchestrator can emit many events
 * in a row without producing N separate Dexie transactions.
 */

import { nanoid } from "nanoid"
import { getDb } from "@/lib/db/schema"
import { recordWorkflowStepUsage, swallowUsageWrite } from "@/lib/db/session-usage"
import type {
  RunEventLogLevel,
  RunEventType,
  StepUsage,
  WorkflowRunEventRow,
} from "@/types/workflow/visual"

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

// ── Coalescing writer ──────────────────────────────────────────────────────
// The orchestrator emits many events per step (started + completed + optional
// stream/usage). Writing each through its own awaited `put` is one IndexedDB
// transaction per event. This queue assigns each event's `ts` synchronously at
// enqueue time (so order is fixed regardless of flush timing), then coalesces
// every event enqueued within the same microtask into ONE `bulkPut`. The
// returned promise still resolves only after the row is durably written, so
// awaiting callers keep their durability guarantee.
interface PendingRunEvent {
  row: WorkflowRunEventRow
  resolve: (row: WorkflowRunEventRow) => void
  reject: (err: unknown) => void
}

let pendingEvents: PendingRunEvent[] = []
let flushScheduled = false

async function flushRunEvents(): Promise<void> {
  flushScheduled = false
  if (pendingEvents.length === 0) return
  const batch = pendingEvents
  pendingEvents = []

  // Group by runId and write one bulkPut per run so a rejection from one run's
  // rows only fails that run's awaiting callers — concurrent healthy runs that
  // happened to coalesce into the same microtask are not aborted. Global `ts`
  // ordering is unaffected (nextTs is a single monotonic watermark, and
  // listRunEvents queries by [runId+ts]).
  const byRun = new Map<string, PendingRunEvent[]>()
  for (const p of batch) {
    const group = byRun.get(p.row.runId)
    if (group) group.push(p)
    else byRun.set(p.row.runId, [p])
  }

  await Promise.all(
    Array.from(byRun.values()).map(async (group) => {
      try {
        await getDb().workflowRunEvents.bulkPut(group.map((p) => p.row))
        for (const p of group) p.resolve(p.row)
      } catch (err) {
        for (const p of group) p.reject(err)
      }
    })
  )
}

/**
 * Enqueue an event into the coalescing writer. `ts` is assigned now (order-
 * stable); events enqueued in the same microtask flush together in one
 * `bulkPut`. The promise resolves once the row is durably written.
 */
export function enqueueRunEvent(input: AppendEventInput): Promise<WorkflowRunEventRow> {
  const row: WorkflowRunEventRow = {
    id: "evt_" + nanoid(10),
    runId: input.runId,
    ts: nextTs(),
    type: input.type,
    stepId: input.stepId,
    level: input.level,
    payload: input.payload,
  }
  return new Promise<WorkflowRunEventRow>((resolve, reject) => {
    pendingEvents.push({ row, resolve, reject })
    if (!flushScheduled) {
      flushScheduled = true
      queueMicrotask(() => void flushRunEvents())
    }
  })
}

/** Test hook — flush the coalescing queue synchronously. */
export async function __flushRunEvents(): Promise<void> {
  await flushRunEvents()
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
 * Emits through the coalescing writer (`enqueueRunEvent`), so events emitted in
 * the same microtask land in a single `bulkPut` instead of N transactions.
 */
export function createRunLogger(runId: string) {
  return {
    runStarted: (payload?: unknown) => enqueueRunEvent({ runId, type: "run_started", payload }),
    runCompleted: (output?: unknown) =>
      enqueueRunEvent({ runId, type: "run_completed", payload: output }),
    runFailed: (error: { message: string; stack?: string; nodeId?: string; code?: string }) =>
      enqueueRunEvent({
        runId,
        type: "run_failed",
        level: "error",
        payload: error,
      }),
    runCancelled: () => enqueueRunEvent({ runId, type: "run_cancelled" }),
    stepStarted: (stepId: string, params?: unknown, meta?: StepIterationMeta) =>
      enqueueRunEvent({ runId, type: "step_started", stepId, payload: { params, ...meta } }),
    stepCompleted: (stepId: string, output: unknown, meta?: StepIterationMeta) =>
      enqueueRunEvent({ runId, type: "step_completed", stepId, payload: { output, ...meta } }),
    stepFailed: (stepId: string, error: { message: string; retryable?: boolean }) =>
      enqueueRunEvent({
        runId,
        type: "step_failed",
        level: "error",
        stepId,
        payload: error,
      }),
    stepSkipped: (stepId: string, reason: string) =>
      enqueueRunEvent({
        runId,
        type: "step_skipped",
        stepId,
        payload: { reason },
      }),
    /**
     * One throttled chunk of streaming LLM output. `seq` is the sink's
     * monotonic flush counter so the UI can order chunks deterministically
     * even when several land in the same millisecond.
     */
    stepStream: (stepId: string, delta: string, seq: number) =>
      enqueueRunEvent({
        runId,
        type: "step_stream",
        stepId,
        payload: { delta, seq },
      }),
    /** Token/cost usage snapshot for one step (payload = StepUsage). */
    stepUsage: (stepId: string, usage: StepUsage) => {
      // Shadow-write into the unified billing table so workflow spend reaches
      // the Subscription → Usage tab. Fire-and-forget: never block or fail the
      // durable event append on the billing mirror.
      swallowUsageWrite(
        recordWorkflowStepUsage({
          runId,
          stepId,
          usage: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadTokens,
            cacheCreationTokens: usage.cacheCreationTokens,
            costUsd: usage.costUsd,
            model: usage.modelId,
            providerId: usage.providerId,
          },
        })
      )
      return enqueueRunEvent({
        runId,
        type: "step_usage",
        stepId,
        payload: usage,
      })
    },
    /** Emitted before each retry backoff wait (attempt = the one that failed). */
    stepRetrying: (
      stepId: string,
      payload: { attempt: number; maxAttempts: number; delayMs: number; error: string }
    ) =>
      enqueueRunEvent({
        runId,
        type: "step_retrying",
        level: "warn",
        stepId,
        payload,
      }),
    log: (level: RunEventLogLevel, message: string, payload?: unknown, stepId?: string) =>
      enqueueRunEvent({
        runId,
        type: "run_log",
        level,
        stepId,
        payload: { message, data: payload },
      }),
  }
}

export type RunLogger = ReturnType<typeof createRunLogger>
