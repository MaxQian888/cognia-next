/**
 * CRUD for the `loops` and `loopEvents` tables (schema v79).
 *
 * Mirrors `lib/db/goals.ts`: the writer enforces the **session-scoped
 * uniqueness invariant** (at most one row per `sessionId` with
 * `status==="active"`), events are append-only and capped per loop, and
 * status/lifecycle smarts live in `lib/loop/runtime.ts` — this module stays
 * mechanical.
 */

import type { Loop, LoopEvent, LoopEventKind, LoopEventPayload, LoopStatus } from "@/types/loop"
import { isTerminalLoopStatus } from "@/types/loop"
import { getDb } from "./schema"
import { resolveSessionProjectId } from "./project-scope"

const EVENTS_PER_LOOP_CAP = 5000

// ─────────────────────────────────────────────────────────────────────────────
// Loop CRUD
// ─────────────────────────────────────────────────────────────────────────────

export type LoopCreateInput = Omit<Loop, "createdAt" | "updatedAt" | "endedAt">

/**
 * Insert a fresh loop row. Caller is responsible for ensuring no other row
 * with the same `sessionId` has `status==="active"` — typically by calling
 * `getActiveLoopForSession` first and transitioning it away.
 */
export async function createLoop(input: LoopCreateInput): Promise<Loop> {
  const now = Date.now()
  // Inherit the session's workspace (Workspace isolation, Dexie v86).
  const projectId = await resolveSessionProjectId(input.sessionId, input.projectId)
  const row: Loop = {
    ...input,
    projectId,
    createdAt: now,
    updatedAt: now,
  }
  await getDb().loops.add(row)
  return row
}

export async function getLoop(id: string): Promise<Loop | undefined> {
  return getDb().loops.get(id)
}

/** The single active loop for a session, or undefined (index-backed). */
export async function getActiveLoopForSession(sessionId: string): Promise<Loop | undefined> {
  return getDb().loops.where("[sessionId+status]").equals([sessionId, "active"]).first()
}

/** Same as `getActiveLoopForSession` but matches "active" OR "paused". */
export async function getOpenLoopForSession(sessionId: string): Promise<Loop | undefined> {
  const db = getDb()
  const active = await db.loops.where("[sessionId+status]").equals([sessionId, "active"]).first()
  if (active) return active
  return db.loops.where("[sessionId+status]").equals([sessionId, "paused"]).first()
}

/** Newest-first list of all loops for a session. */
export async function listLoopsBySession(sessionId: string): Promise<Loop[]> {
  return getDb().loops.where("sessionId").equals(sessionId).reverse().sortBy("createdAt")
}

/** Reverse lookup from the backing scheduler task (interval mode). */
export async function getLoopByScheduledTask(taskId: string): Promise<Loop | undefined> {
  return getDb().loops.where("scheduledTaskId").equals(taskId).first()
}

export interface LoopUpdatePatch {
  status?: LoopStatus
  iterations?: number
  tokensUsed?: number
  generationId?: string
  config?: Loop["config"]
  endedAt?: number
  scheduledTaskId?: string
  nextDelayMs?: number
  nextDelayReason?: string
  lastIterationAt?: number
  parseFailureCount?: number
}

/**
 * Apply a partial patch. Always bumps `updatedAt`; back-fills `endedAt` when
 * the patch transitions into a terminal status.
 */
export async function updateLoop(id: string, patch: LoopUpdatePatch): Promise<void> {
  const now = Date.now()
  const next: Partial<Loop> = { ...patch, updatedAt: now }
  if (patch.status && isTerminalLoopStatus(patch.status) && patch.endedAt == null) {
    next.endedAt = now
  }
  await getDb().loops.update(id, next)
}

/** Cascade-delete: the loop AND every event for it, in one transaction. */
export async function deleteLoop(id: string): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.loops, db.loopEvents, async () => {
    await db.loopEvents.where("loopId").equals(id).delete()
    await db.loops.delete(id)
  })
}

/**
 * Cascade-delete every loop (and its events) for a session. The caller
 * (session-delete path) is responsible for tearing down any backing
 * scheduler tasks FIRST — this function only touches Dexie. Returns the
 * deleted rows so the caller can do exactly that.
 */
export async function deleteLoopsForSession(sessionId: string): Promise<Loop[]> {
  const db = getDb()
  const rows = await db.loops.where("sessionId").equals(sessionId).toArray()
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.id)
  await db.transaction("rw", db.loops, db.loopEvents, async () => {
    await db.loopEvents.where("loopId").anyOf(ids).delete()
    await db.loops.bulkDelete(ids)
  })
  return rows
}

// ─────────────────────────────────────────────────────────────────────────────
// Event log
// ─────────────────────────────────────────────────────────────────────────────

export interface AppendLoopEventInput {
  loopId: string
  kind: LoopEventKind
  payload: LoopEventPayload
  /** Pre-existing timestamp (test fixtures). Defaults to `Date.now()`. */
  ts?: number
  /** Pre-existing id (test fixtures). Defaults to a fresh UUIDv4. */
  id?: string
}

/**
 * Append a lifecycle event. Runs in a transaction together with the
 * per-loop cap-prune so heavy looping can't blow the table up.
 */
export async function appendLoopEvent(input: AppendLoopEventInput): Promise<LoopEvent> {
  const db = getDb()
  const row: LoopEvent = {
    id: input.id ?? crypto.randomUUID(),
    loopId: input.loopId,
    kind: input.kind,
    ts: input.ts ?? Date.now(),
    payload: input.payload,
  }
  await db.transaction("rw", db.loopEvents, async () => {
    await db.loopEvents.add(row)
    await pruneEventsForLoop(input.loopId, EVENTS_PER_LOOP_CAP)
  })
  return row
}

/** Newest-first list of events for a loop. Capped by `limit` (default 200). */
export async function listLoopEvents(loopId: string, limit = 200): Promise<LoopEvent[]> {
  const collection = getDb()
    .loopEvents.where("[loopId+ts]")
    .between([loopId, -Infinity], [loopId, Infinity])
    .reverse()
  if (limit > 0) collection.limit(limit)
  return collection.toArray()
}

/** Prune oldest events so a loop holds at most `keep` entries. */
async function pruneEventsForLoop(loopId: string, keep: number): Promise<void> {
  const db = getDb()
  const total = await db.loopEvents.where("loopId").equals(loopId).count()
  if (total <= keep) return
  const overflow = total - keep
  const oldest = await db.loopEvents
    .where("[loopId+ts]")
    .between([loopId, -Infinity], [loopId, Infinity])
    .limit(overflow)
    .primaryKeys()
  if (oldest.length > 0) {
    await db.loopEvents.bulkDelete(oldest as string[])
  }
}

/** Test-only escape hatch. */
export const __TESTING__ = { EVENTS_PER_LOOP_CAP, pruneEventsForLoop }
