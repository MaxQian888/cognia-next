import Dexie from "dexie"
import { reduceRunEvents } from "@/lib/execution/run-reducer"
import type {
  ExecutionRun,
  ExecutionRunBinding,
  ExecutionRunKind,
  ExecutionRunStatus,
  RunEvent,
  RunEventType,
  RunEventVisibility,
  RunProjectionSnapshot,
} from "@/types/execution/run"
import { getDb, withDbReopenRetry } from "./schema"
import { redactText } from "@cognia/redact"

export type AppendRunEventInput = Omit<RunEvent, "id" | "runId" | "seq" | "projectId"> & {
  id?: string
}

function eventId(runId: string, input: AppendRunEventInput): string {
  if (input.id) return input.id
  if (input.sourceEventId) return `execution-event:${runId}:${input.sourceEventId}`
  return `execution-event:${crypto.randomUUID()}`
}

function redactPayloadValue(value: unknown): unknown {
  if (typeof value === "string") return redactText(value).redacted
  if (Array.isArray(value)) return value.map(redactPayloadValue)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        redactPayloadValue(child),
      ])
    )
  }
  return value
}

function redactPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return redactPayloadValue(payload) as Record<string, unknown>
}

export async function createExecutionRun(run: ExecutionRun): Promise<ExecutionRun> {
  await withDbReopenRetry(() =>
    getDb()
      .executionRuns.add(run)
      .then(() => undefined)
  )
  return run
}

export async function getExecutionRun(runId: string): Promise<ExecutionRun | undefined> {
  return getDb().executionRuns.get(runId)
}

export interface ExecutionRunQuery {
  kinds?: readonly ExecutionRunKind[]
  statuses?: readonly ExecutionRunStatus[]
  projectId?: string
  sessionId?: string
  limit?: number
}

/** Canonical query used by Agent Runs, monitoring, and remote-safe projections. */
export async function listExecutionRuns(query: ExecutionRunQuery = {}): Promise<ExecutionRun[]> {
  const kinds = query.kinds ? new Set(query.kinds) : undefined
  const statuses = query.statuses ? new Set(query.statuses) : undefined
  const limit = Math.max(1, query.limit ?? 50)
  return getDb()
    .executionRuns.orderBy("updatedAt")
    .reverse()
    .filter(
      (run) =>
        (!kinds || kinds.has(run.kind)) &&
        (!statuses || statuses.has(run.status)) &&
        (!query.projectId || run.projectId === query.projectId) &&
        (!query.sessionId || run.sessionId === query.sessionId)
    )
    .limit(limit)
    .toArray()
}

/**
 * Every run that belongs to `parentRunId`, newest first.
 *
 * Indexed since v176. Before that the column existed but the question cost a
 * full scan, so nothing asked it — which is why a delegation could not roll its
 * children onto one card and `retry` could not link a replacement run.
 */
export async function listChildExecutionRuns(
  parentRunId: string,
  options: { statuses?: readonly ExecutionRunStatus[] } = {}
): Promise<ExecutionRun[]> {
  const statuses = options.statuses ? new Set(options.statuses) : undefined
  const rows = await getDb().executionRuns.where("parentRunId").equals(parentRunId).toArray()
  return rows
    .filter((run) => !statuses || statuses.has(run.status))
    .sort((left, right) => right.updatedAt - left.updatedAt)
}

/**
 * Adopt an already-created run into a parent.
 *
 * The delegation path cannot always create the child itself: an agent turn is
 * minted by the runtime before anyone knows the turn will be promoted to
 * background work. Adoption is how a run that started inline joins the
 * delegation that later took it over, instead of the delegation having to
 * pre-empt a decision it does not yet have the evidence for.
 */
export async function adoptExecutionRun(runId: string, parentRunId: string): Promise<boolean> {
  if (runId === parentRunId) return false
  const run = await getExecutionRun(runId)
  if (!run || run.parentRunId === parentRunId) return false
  await getDb().executionRuns.update(runId, { parentRunId })
  return true
}

export async function createExecutionRunBinding(
  binding: ExecutionRunBinding
): Promise<ExecutionRunBinding> {
  await getDb().executionRunBindings.add(binding)
  return binding
}

export async function putExecutionRunBinding(
  binding: ExecutionRunBinding
): Promise<ExecutionRunBinding> {
  await withDbReopenRetry(() =>
    getDb()
      .executionRunBindings.put(binding)
      .then(() => undefined)
  )
  return binding
}

export async function getExecutionRunBinding(
  bindingId: string
): Promise<ExecutionRunBinding | undefined> {
  return getDb().executionRunBindings.get(bindingId)
}

export async function listExecutionRunBindings(runId: string): Promise<ExecutionRunBinding[]> {
  return getDb().executionRunBindings.where("runId").equals(runId).toArray()
}

export async function updateExecutionRunBinding(
  bindingId: string,
  patch: Partial<ExecutionRunBinding>
): Promise<void> {
  // `updatedAt` is the companion-sync cursor for this table
  // (`readExecutionRunBindingsDelta`); a patch that leaves it alone would
  // change the row without ever re-sending it.
  await getDb().executionRunBindings.update(bindingId, {
    ...patch,
    updatedAt: patch.updatedAt ?? Date.now(),
  })
}

export async function listExecutionRunEvents(runId: string): Promise<RunEvent[]> {
  return getDb()
    .executionRunEvents.where("[runId+seq]")
    .between([runId, 0], [runId, Number.POSITIVE_INFINITY])
    .toArray()
}

export async function listVisibleExecutionRunEvents(
  runId: string,
  includePrivate = false
): Promise<RunEvent[]> {
  const events = await listExecutionRunEvents(runId)
  return includePrivate ? events : events.filter((event) => event.visibility !== "private")
}

export async function getExecutionRunSnapshot(
  runId: string
): Promise<RunProjectionSnapshot | undefined> {
  return (await getExecutionRun(runId))?.latestSnapshot
}

/**
 * Append a run event using the caller's already-open transaction.
 *
 * {@link runEventJournal.append} cannot be used from inside another
 * transaction: it wraps itself in `withDbReopenRetry` + a fresh
 * `db.transaction(...)`, and the retry wrapper breaks out of Dexie's
 * transaction zone. Callers that must journal atomically alongside other
 * writes — the work-submission acceptance transaction, for one — take this
 * entry point instead and supply the `db` bound to their transaction.
 *
 * The caller's transaction scope must already include `executionRuns` and
 * `executionRunEvents`.
 */
export function appendRunEventInsideTransaction(
  db: ReturnType<typeof getDb>,
  runId: string,
  input: AppendRunEventInput
): Promise<RunEvent> {
  return appendInsideTransaction(db, runId, input)
}

function appendInsideTransaction(
  db: ReturnType<typeof getDb>,
  runId: string,
  input: AppendRunEventInput
): Promise<RunEvent> {
  const id = eventId(runId, input)
  return db.executionRuns.get(runId).then((run) => {
    if (!run) throw new Error(`Execution run not found: ${runId}`)
    return db.executionRunEvents.get(id).then((duplicate) => {
      if (duplicate) return duplicate
      if (["completed", "failed", "cancelled"].includes(run.status)) {
        throw new Error(`Execution run is terminal: ${runId}`)
      }

      const event: RunEvent = {
        id,
        runId,
        seq: run.currentRevision + 1,
        ts: input.ts,
        type: input.type,
        visibility: input.visibility,
        payload: redactPayload(input.payload),
        ...(run.projectId ? { projectId: run.projectId } : {}),
        ...(input.sourceEventId ? { sourceEventId: input.sourceEventId } : {}),
      }
      return db.executionRunEvents
        .add(event)
        .then(() =>
          db.executionRunEvents
            .where("[runId+seq]")
            .between([runId, 0], [runId, Number.POSITIVE_INFINITY])
            .toArray()
        )
        .then((events) => {
          const snapshot = reduceRunEvents({ ...run, currentRevision: 0 }, events)
          return db.executionRuns
            .update(runId, {
              status: snapshot.status,
              currentRevision: snapshot.revision,
              latestSnapshot: snapshot,
              updatedAt: snapshot.updatedAt,
              ...(snapshot.endedAt !== undefined ? { endedAt: snapshot.endedAt } : {}),
            })
            .then(() => event)
        })
    })
  })
}

export interface RunEventJournal {
  append(runId: string, input: AppendRunEventInput): Promise<RunEvent>
  appendBatch(runId: string, inputs: readonly AppendRunEventInput[]): Promise<RunEvent[]>
  replay(runId: string): Promise<RunEvent[]>
  getSnapshot(runId: string): Promise<RunProjectionSnapshot | undefined>
  subscribe(
    runId: string,
    listener: (snapshot: RunProjectionSnapshot | undefined) => void
  ): () => void
}

export const runEventJournal: RunEventJournal = {
  async append(runId, input) {
    const idempotentInput = input.id ? input : { ...input, id: eventId(runId, input) }
    return withDbReopenRetry(() => {
      const db = getDb()
      return db.transaction("rw", db.executionRuns, db.executionRunEvents, () =>
        appendInsideTransaction(db, runId, idempotentInput)
      )
    })
  },

  async appendBatch(runId, inputs) {
    const idempotentInputs = inputs.map((input) =>
      input.id ? input : { ...input, id: eventId(runId, input) }
    )
    return withDbReopenRetry(() => {
      const db = getDb()
      return db.transaction("rw", db.executionRuns, db.executionRunEvents, () => {
        const initial = db.executionRuns.get(runId).then(() => [] as RunEvent[])
        return idempotentInputs.reduce<Promise<RunEvent[]>>(
          (pending, input) =>
            pending.then((out) =>
              appendInsideTransaction(db, runId, input).then((event) => {
                out.push(event)
                return out
              })
            ),
          initial
        )
      })
    })
  },

  replay: listExecutionRunEvents,
  getSnapshot: getExecutionRunSnapshot,

  subscribe(runId, listener) {
    // `Dexie.liveQuery`, not a named `liveQuery` import: dexie's CJS build makes
    // `liveQuery` non-enumerable, so SWC's wildcard interop drops it the moment a
    // module also imports the `Dexie` default. See `lib/db/outbound-jobs.ts`.
    const subscription = Dexie.liveQuery(() => getExecutionRunSnapshot(runId)).subscribe({
      next: listener,
      error: () => listener(undefined),
    })
    return () => subscription.unsubscribe()
  },
}

export const EXECUTION_RUN_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000

export async function sweepExecutionRunEventRetention(now: number = Date.now()): Promise<number> {
  const cutoff = now - EXECUTION_RUN_EVENT_RETENTION_MS
  const terminalRuns = await getDb()
    .executionRuns.where("status")
    .anyOf("completed", "failed", "cancelled")
    .toArray()
  const expiredRunIds = terminalRuns
    .filter((run) => run.endedAt !== undefined && run.endedAt < cutoff)
    .map((run) => run.id)
  let deleted = 0
  await getDb().transaction("rw", getDb().executionRunEvents, async () => {
    for (const runId of expiredRunIds) {
      deleted += await getDb().executionRunEvents.where("runId").equals(runId).delete()
    }
  })
  return deleted
}

/** Convenience constructor for source mappers that already have semantic payloads. */
export function semanticRunEvent(
  type: RunEventType,
  payload: Record<string, unknown>,
  options: {
    ts?: number
    visibility?: RunEventVisibility
    sourceEventId?: string
  } = {}
): AppendRunEventInput {
  return {
    type,
    payload,
    ts: options.ts ?? Date.now(),
    visibility: options.visibility ?? "summary",
    ...(options.sourceEventId ? { sourceEventId: options.sourceEventId } : {}),
  }
}
