import { liveQuery } from "dexie"
import { reduceRunEvents } from "@/lib/execution/run-reducer"
import type {
  ExecutionRun,
  ExecutionRunBinding,
  RunEvent,
  RunEventType,
  RunEventVisibility,
  RunProjectionSnapshot,
} from "@/types/execution/run"
import { getDb } from "./schema"
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
  const db = getDb()
  await db.executionRuns.add(run)
  return run
}

export async function getExecutionRun(runId: string): Promise<ExecutionRun | undefined> {
  return getDb().executionRuns.get(runId)
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
  await getDb().executionRunBindings.put(binding)
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
  await getDb().executionRunBindings.update(bindingId, patch)
}

export async function listExecutionRunEvents(runId: string): Promise<RunEvent[]> {
  return getDb()
    .executionRunEvents.where("[runId+seq]")
    .between([runId, 0], [runId, Number.POSITIVE_INFINITY])
    .toArray()
}

export async function getExecutionRunSnapshot(
  runId: string
): Promise<RunProjectionSnapshot | undefined> {
  return (await getExecutionRun(runId))?.latestSnapshot
}

async function appendInsideTransaction(
  runId: string,
  input: AppendRunEventInput
): Promise<RunEvent> {
  const db = getDb()
  const run = await db.executionRuns.get(runId)
  if (!run) throw new Error(`Execution run not found: ${runId}`)

  const id = eventId(runId, input)
  const duplicate = await db.executionRunEvents.get(id)
  if (duplicate) return duplicate

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
  await db.executionRunEvents.add(event)

  const events = await db.executionRunEvents
    .where("[runId+seq]")
    .between([runId, 0], [runId, Number.POSITIVE_INFINITY])
    .toArray()
  const snapshot = reduceRunEvents({ ...run, currentRevision: 0 }, events)
  await db.executionRuns.update(runId, {
    status: snapshot.status,
    currentRevision: snapshot.revision,
    latestSnapshot: snapshot,
    updatedAt: snapshot.updatedAt,
    ...(snapshot.endedAt !== undefined ? { endedAt: snapshot.endedAt } : {}),
  })
  return event
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
    const db = getDb()
    return db.transaction("rw", db.executionRuns, db.executionRunEvents, () =>
      appendInsideTransaction(runId, input)
    )
  },

  async appendBatch(runId, inputs) {
    const db = getDb()
    return db.transaction("rw", db.executionRuns, db.executionRunEvents, async () => {
      const out: RunEvent[] = []
      for (const input of inputs) out.push(await appendInsideTransaction(runId, input))
      return out
    })
  },

  replay: listExecutionRunEvents,
  getSnapshot: getExecutionRunSnapshot,

  subscribe(runId, listener) {
    const subscription = liveQuery(() => getExecutionRunSnapshot(runId)).subscribe({
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
