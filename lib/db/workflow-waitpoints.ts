import type {
  WorkflowWaitEvent,
  WorkflowWaitpoint,
  WorkflowWaitpointDecisionResult,
  WorkflowWaitpointKind,
  WorkflowWaitpointRepository,
  WorkflowWaitpointResolution,
} from "@/types/workflow/waitpoint"
import { getDb } from "./schema"
import {
  createNativeWorkflowWaitpoint,
  decideNativeWorkflowWaitpoint,
  getNativeWorkflowWaitpoint,
  listNativePendingWorkflowWaitpoints,
  persistNativeWorkflowWaitEvent,
  pruneNativeWorkflowWaitEvents,
} from "@/lib/workflow/runtime/tauri-bridge"
import { ACTION_REVIEW_RETENTION_DAYS, recordActionReviewReceipt } from "./action-review-receipts"

export const WORKFLOW_WAIT_EVENT_TTL_MS = 24 * 60 * 60 * 1000
const MS_PER_DAY = 24 * 60 * 60 * 1000

const listeners = new Set<(waitpoint: WorkflowWaitpoint) => void>()

function notify(waitpoint: WorkflowWaitpoint): void {
  for (const listener of listeners) listener(waitpoint)
}

function statusFor(resolution: WorkflowWaitpointResolution): WorkflowWaitpoint["status"] {
  if (resolution.outcome === "rejected") return "rejected"
  if (resolution.outcome === "timed_out") return "timed_out"
  if (resolution.outcome === "cancelled") return "cancelled"
  return "resolved"
}

function eventMatches(waitpoint: WorkflowWaitpoint, event: WorkflowWaitEvent): boolean {
  return (
    waitpoint.kind === "event_wait" &&
    waitpoint.status === "pending" &&
    waitpoint.key === event.key &&
    (!waitpoint.correlationId || waitpoint.correlationId === event.correlationId) &&
    event.emittedAt >= waitpoint.notBefore &&
    !event.consumedByWaitpointId
  )
}

async function recordWorkflowWaitpointReceipt(waitpoint: WorkflowWaitpoint): Promise<void> {
  const resolution = waitpoint.resolution
  if (
    !resolution ||
    (waitpoint.kind !== "approval" && waitpoint.kind !== "risk_gate") ||
    resolution.outcome === "event"
  ) {
    return
  }
  const outcome =
    resolution.outcome === "approved"
      ? "allow"
      : resolution.outcome === "timed_out"
        ? "expired"
        : resolution.outcome === "cancelled"
          ? "interrupted"
          : "deny"
  const authority =
    resolution.outcome === "timed_out"
      ? "timeout"
      : resolution.outcome === "cancelled"
        ? "system"
        : "human"
  const respondedBy = resolution.respondedBy
  const actor = respondedBy?.startsWith("device:")
    ? { kind: "device" as const, id: respondedBy.slice("device:".length) }
    : authority === "human"
      ? { kind: "local-user" as const, ...(respondedBy ? { label: respondedBy } : {}) }
      : undefined
  await recordActionReviewReceipt({
    contractVersion: 1,
    id: waitpoint.id,
    request: {
      contractVersion: 1,
      requestId: waitpoint.id,
      origin: {
        channel: "workflow-step",
        scope: "workflow-step",
        id: waitpoint.id,
        runId: waitpoint.runId,
        workflowId: waitpoint.workflowId,
      },
      subject: {
        kind: "workflow-step",
        ref: waitpoint.stepId,
      },
      verdict: "ask",
      verdictExplicit: false,
      tier: waitpoint.kind === "risk_gate" ? "high" : "medium",
      surfaces: [],
      requestedAt: waitpoint.createdAt,
      ...(waitpoint.expiresAt !== undefined ? { expiresAt: waitpoint.expiresAt } : {}),
    },
    decision: {
      contractVersion: 1,
      requestId: waitpoint.id,
      outcome,
      authority,
      ...(actor ? { actor } : {}),
      decidedAt: resolution.resolvedAt,
    },
    ...(outcome === "allow"
      ? {}
      : { effect: { status: "blocked", completedAt: resolution.resolvedAt } }),
    expiresAt: resolution.resolvedAt + ACTION_REVIEW_RETENTION_DAYS * MS_PER_DAY,
  })
}

async function consumeEarliestEvent(
  waitpoint: WorkflowWaitpoint
): Promise<WorkflowWaitpoint | undefined> {
  const db = getDb()
  const events = await db.workflowWaitEvents
    .where("[key+emittedAt]")
    .between([waitpoint.key, waitpoint.notBefore], [waitpoint.key, DexieMaxKey])
    .toArray()
  const event = events.find((candidate) => eventMatches(waitpoint, candidate))
  if (!event) return undefined
  const now = Date.now()
  event.consumedByWaitpointId = waitpoint.id
  event.consumedAt = now
  const resolved: WorkflowWaitpoint = {
    ...waitpoint,
    status: "resolved",
    resolution: {
      outcome: "event",
      respondedBy: event.source,
      data: event.data,
      resolvedAt: event.emittedAt,
    },
    updatedAt: now,
  }
  await db.workflowWaitEvents.put(event)
  await db.workflowWaitpoints.put(resolved)
  return resolved
}

// Dexie's public max-key sentinel is not available in every bundled build;
// this string remains above all practical millisecond timestamps in the
// compound key because the second component is numeric.
const DexieMaxKey = Number.MAX_SAFE_INTEGER

export async function createWorkflowWaitpoint(
  waitpoint: WorkflowWaitpoint
): Promise<WorkflowWaitpoint> {
  const db = getDb()
  let stored = waitpoint
  await db.transaction("rw", db.workflowWaitpoints, db.workflowWaitEvents, async () => {
    const existing = await db.workflowWaitpoints.get(waitpoint.id)
    if (existing) {
      stored = existing
      return
    }
    await db.workflowWaitpoints.add(waitpoint)
    stored = (await consumeEarliestEvent(waitpoint)) ?? waitpoint
  })
  const native = await createNativeWorkflowWaitpoint(stored)
  if (native) {
    stored = native
    await db.workflowWaitpoints.put(native)
  }
  if (stored.status !== "pending") await recordWorkflowWaitpointReceipt(stored)
  notify(stored)
  return stored
}

export async function getWorkflowWaitpoint(id: string): Promise<WorkflowWaitpoint | undefined> {
  const native = await getNativeWorkflowWaitpoint(id)
  if (native) {
    await getDb().workflowWaitpoints.put(native)
    if (native.status !== "pending") await recordWorkflowWaitpointReceipt(native)
    return native
  }
  return getDb().workflowWaitpoints.get(id)
}

export async function listPendingWorkflowWaitpoints(
  kind?: WorkflowWaitpointKind
): Promise<WorkflowWaitpoint[]> {
  const db = getDb()
  const local = kind
    ? await db.workflowWaitpoints.where("[kind+status]").equals([kind, "pending"]).toArray()
    : await db.workflowWaitpoints.where("status").equals("pending").toArray()
  const native = await listNativePendingWorkflowWaitpoints()
  if (native) await db.workflowWaitpoints.bulkPut(native)
  const rows = new Map(local.map((row) => [row.id, row]))
  for (const row of native ?? []) {
    if (!kind || row.kind === kind) rows.set(row.id, row)
  }
  return [...rows.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}

/** Transactional compare-and-set: only the first terminal decision wins. */
export async function decideWorkflowWaitpoint(
  id: string,
  resolution: WorkflowWaitpointResolution
): Promise<WorkflowWaitpointDecisionResult> {
  const db = getDb()
  const nativeCurrent = await getNativeWorkflowWaitpoint(id)
  if (nativeCurrent?.status !== undefined && nativeCurrent.status !== "pending") {
    await db.workflowWaitpoints.put(nativeCurrent)
    await recordWorkflowWaitpointReceipt(nativeCurrent)
    notify(nativeCurrent)
    return { ok: false, reason: "already-decided" }
  }
  if (nativeCurrent) {
    const nativeWon = await decideNativeWorkflowWaitpoint(id, resolution)
    if (nativeWon === false) {
      const winner = await getNativeWorkflowWaitpoint(id)
      if (winner) {
        await db.workflowWaitpoints.put(winner)
        notify(winner)
      }
      return { ok: false, reason: "already-decided" }
    }
  }
  const result = await db.transaction<WorkflowWaitpointDecisionResult>(
    "rw",
    db.workflowWaitpoints,
    async () => {
      const current = await db.workflowWaitpoints.get(id)
      if (!current) return { ok: false, reason: "not-found" }
      if (current.status !== "pending") {
        return { ok: false, reason: "already-decided" }
      }
      const waitpoint: WorkflowWaitpoint = {
        ...current,
        status: statusFor(resolution),
        resolution,
        updatedAt: resolution.resolvedAt,
      }
      await db.workflowWaitpoints.put(waitpoint)
      return { ok: true, waitpoint }
    }
  )
  if (result.ok && !nativeCurrent) {
    await decideNativeWorkflowWaitpoint(id, resolution)
  }
  if (result.ok) {
    await recordWorkflowWaitpointReceipt(result.waitpoint)
    notify(result.waitpoint)
  }
  return result
}

export function cancelWorkflowWaitpoint(
  id: string,
  respondedBy: string,
  resolvedAt = Date.now()
): Promise<WorkflowWaitpointDecisionResult> {
  return decideWorkflowWaitpoint(id, {
    outcome: "cancelled",
    respondedBy,
    resolvedAt,
  })
}

export async function emitWorkflowWaitEvent(event: WorkflowWaitEvent): Promise<WorkflowWaitEvent> {
  const db = getDb()
  await persistNativeWorkflowWaitEvent(event)
  let stored = event
  let resolved: WorkflowWaitpoint | undefined
  await db.transaction("rw", db.workflowWaitpoints, db.workflowWaitEvents, async () => {
    const existing = await db.workflowWaitEvents.get(event.id)
    if (existing) {
      stored = existing
      return
    }
    await db.workflowWaitEvents.add(event)
    const candidates = await db.workflowWaitpoints
      .where("[key+status]")
      .equals([event.key, "pending"])
      .toArray()
    const waitpoint = candidates
      .filter((candidate) => eventMatches(candidate, event))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0]
    if (!waitpoint) return
    const consumedAt = Date.now()
    stored = {
      ...event,
      consumedByWaitpointId: waitpoint.id,
      consumedAt,
    }
    resolved = {
      ...waitpoint,
      status: "resolved",
      resolution: {
        outcome: "event",
        respondedBy: event.source,
        data: event.data,
        resolvedAt: event.emittedAt,
      },
      updatedAt: consumedAt,
    }
    await db.workflowWaitEvents.put(stored)
    await db.workflowWaitpoints.put(resolved)
  })
  if (resolved) {
    await decideNativeWorkflowWaitpoint(resolved.id, resolved.resolution!)
    notify(resolved)
  }
  return stored
}

export async function pruneExpiredWorkflowWaitEvents(now = Date.now()): Promise<number> {
  const table = getDb().workflowWaitEvents
  const ids = await table.where("expiresAt").belowOrEqual(now).primaryKeys()
  if (ids.length > 0) await table.bulkDelete(ids as string[])
  await pruneNativeWorkflowWaitEvents(now)
  return ids.length
}

export function subscribeWorkflowWaitpointChanges(
  listener: (waitpoint: WorkflowWaitpoint) => void
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function createDexieWorkflowWaitpointRepository(): WorkflowWaitpointRepository {
  return {
    create: createWorkflowWaitpoint,
    get: getWorkflowWaitpoint,
    listPending: listPendingWorkflowWaitpoints,
    decide: decideWorkflowWaitpoint,
    cancel: cancelWorkflowWaitpoint,
    emit: emitWorkflowWaitEvent,
    pruneExpiredEvents: pruneExpiredWorkflowWaitEvents,
  }
}

export function createWorkflowWaitEvent(input: {
  id?: string
  key: string
  correlationId?: string
  source: string
  data?: unknown
  emittedAt?: number
}): WorkflowWaitEvent {
  const emittedAt = input.emittedAt ?? Date.now()
  return {
    id: input.id ?? `wfe_${emittedAt.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    key: input.key,
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    source: input.source,
    ...(input.data !== undefined ? { data: input.data } : {}),
    emittedAt,
    expiresAt: emittedAt + WORKFLOW_WAIT_EVENT_TTL_MS,
  }
}
