/**
 * CRUD for the `agentPlans` and `agentPlanEvents` tables (schema v71, ADR-0045).
 *
 * Writer enforces the **session-scoped open-plan invariant**: at most one row
 * per `sessionId` may carry an "open" status (draft / awaiting_approval /
 * approved / executing / paused — see `OPEN_PLAN_STATUSES`). Callers that
 * create a new plan while one is already open MUST first transition the prior
 * open plan to a terminal status; `lib/agent/plan/runtime.ts` owns that logic
 * and this module stays mechanical.
 *
 * Events are append-only and capped at 2000 newest per plan via
 * `EVENTS_PER_PLAN_CAP` (per-plan, so a long plan can't starve another's log).
 */

import type {
  AgentPlan,
  PlanEvent,
  PlanEventKind,
  PlanEventPayload,
  PlanStatus,
} from "@/types/agent/plan"
import { OPEN_PLAN_STATUSES, isTerminalPlanStatus } from "@/types/agent/plan"
import Dexie from "dexie"
import { getDb, withDbReopenRetry } from "./schema"
import { resolveScopeProjectId, resolveSessionProjectId } from "./project-scope"

const EVENTS_PER_PLAN_CAP = 2000

// ─────────────────────────────────────────────────────────────────────────────
// Plan CRUD
// ─────────────────────────────────────────────────────────────────────────────

export type PlanCreateInput = Omit<AgentPlan, "createdAt" | "updatedAt" | "endedAt">

/**
 * Insert a fresh plan row. Caller is responsible for ensuring no other row
 * with the same `sessionId` is open — typically by calling
 * `getOpenPlanForSession` first and transitioning it away.
 */
export async function createPlan(input: PlanCreateInput): Promise<AgentPlan> {
  const now = Date.now()
  // Inherit the session's workspace (Workspace isolation, Dexie v86).
  const projectId = await resolveSessionProjectId(input.sessionId, input.projectId)
  const row: AgentPlan = { ...input, projectId, createdAt: now, updatedAt: now }
  await getDb().agentPlans.add(row)
  return row
}

export async function getPlan(id: string): Promise<AgentPlan | undefined> {
  return getDb().agentPlans.get(id)
}

/**
 * Return the single open (non-terminal) plan for a session, or undefined.
 * Walks `OPEN_PLAN_STATUSES` against the `[sessionId+status]` index so each
 * probe is O(log n) regardless of history depth.
 */
export async function getOpenPlanForSession(sessionId: string): Promise<AgentPlan | undefined> {
  const db = getDb()
  for (const status of OPEN_PLAN_STATUSES) {
    const hit = await db.agentPlans.where("[sessionId+status]").equals([sessionId, status]).first()
    if (hit) return hit
  }
  return undefined
}

/** The plan currently executing for a session (status === "executing"), if any. */
export async function getExecutingPlanForSession(
  sessionId: string
): Promise<AgentPlan | undefined> {
  return getDb().agentPlans.where("[sessionId+status]").equals([sessionId, "executing"]).first()
}

/** Newest-first list of all plans for a session (open and terminal). */
export async function listPlansBySession(sessionId: string): Promise<AgentPlan[]> {
  return getDb().agentPlans.where("sessionId").equals(sessionId).reverse().sortBy("createdAt")
}

/**
 * Newest-first list of all plans in one workspace (defaults to the active
 * project via the central scope helper). Working-set surface — shows only the
 * current workspace. Uses the `[projectId+createdAt]` compound index (v86).
 */
export async function listAllPlans(limit = 500, projectId?: string): Promise<AgentPlan[]> {
  const pid = await resolveScopeProjectId(projectId)
  return getDb()
    .agentPlans.where("[projectId+createdAt]")
    .between([pid, Dexie.minKey], [pid, Dexie.maxKey])
    .reverse()
    .limit(limit)
    .toArray()
}

export interface PlanUpdatePatch {
  title?: string
  description?: string
  status?: PlanStatus
  steps?: AgentPlan["steps"]
  currentStepId?: string
  totalSteps?: number
  completedSteps?: number
  executionMode?: AgentPlan["executionMode"]
  config?: AgentPlan["config"]
  refinementCount?: number
  generationId?: string
  endedAt?: number
  metadata?: AgentPlan["metadata"]
}

/**
 * Apply a partial patch to a plan. Always bumps `updatedAt`. When the patch
 * transitions the status into a terminal state, `endedAt` is back-filled
 * automatically if the caller didn't supply one.
 */
export async function updatePlan(id: string, patch: PlanUpdatePatch): Promise<void> {
  const now = Date.now()
  const next: Partial<AgentPlan> = { ...patch, updatedAt: now }
  if (patch.status && isTerminalPlanStatus(patch.status) && patch.endedAt == null) {
    next.endedAt = now
  }
  await getDb().agentPlans.update(id, next)
}

/**
 * Cascade-delete: drop the plan AND every event for it in one transaction so
 * a crash mid-delete can't leave orphans.
 */
export async function deletePlan(id: string): Promise<void> {
  await withDbReopenRetry(() => {
    const db = getDb()
    return db.transaction("rw", db.agentPlans, db.agentPlanEvents, () =>
      Promise.all([
        db.agentPlanEvents.where("planId").equals(id).delete(),
        db.agentPlans.delete(id),
      ]).then(() => undefined)
    )
  })
}

/** Cascade-delete every plan (and its events) for a given session. */
export async function deletePlansForSession(sessionId: string): Promise<void> {
  await withDbReopenRetry(() => {
    const db = getDb()
    return db.transaction("rw", db.agentPlans, db.agentPlanEvents, () =>
      db.agentPlans
        .where("sessionId")
        .equals(sessionId)
        .primaryKeys()
        .then((ids) => {
          if (ids.length === 0) return
          return Promise.all([
            db.agentPlanEvents
              .where("planId")
              .anyOf(ids as string[])
              .delete(),
            db.agentPlans.bulkDelete(ids as string[]),
          ]).then(() => undefined)
        })
    )
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Event log
// ─────────────────────────────────────────────────────────────────────────────

export interface AppendPlanEventInput {
  planId: string
  kind: PlanEventKind
  payload: PlanEventPayload
  /** Pre-existing timestamp (test fixtures). Defaults to `Date.now()`. */
  ts?: number
  /** Pre-existing id (test fixtures). Defaults to a fresh UUIDv4. */
  id?: string
}

/**
 * Append a lifecycle event for a plan. Runs in a transaction with the
 * per-plan cap-prune so the table can't blow up under heavy looping.
 */
export async function appendPlanEvent(input: AppendPlanEventInput): Promise<PlanEvent> {
  const row: PlanEvent = {
    id: input.id ?? crypto.randomUUID(),
    planId: input.planId,
    kind: input.kind,
    ts: input.ts ?? Date.now(),
    payload: input.payload,
  }
  await withDbReopenRetry(() => {
    const db = getDb()
    return db.transaction("rw", db.agentPlanEvents, () =>
      db.agentPlanEvents
        .put(row)
        .then(() => pruneEventsForPlan(input.planId, EVENTS_PER_PLAN_CAP, db))
    )
  })
  return row
}

/** Newest-first list of events for a plan. Capped by `limit` (default 200). */
export async function listPlanEvents(planId: string, limit = 200): Promise<PlanEvent[]> {
  const collection = getDb()
    .agentPlanEvents.where("[planId+ts]")
    .between([planId, -Infinity], [planId, Infinity])
    .reverse()
  if (limit > 0) collection.limit(limit)
  return collection.toArray()
}

/** Number of events on file for a plan. */
export async function countPlanEvents(planId: string): Promise<number> {
  return getDb().agentPlanEvents.where("planId").equals(planId).count()
}

/**
 * Prune oldest events for a single plan so it holds at most `keep` entries.
 * Caller wraps in a transaction.
 */
function pruneEventsForPlan(
  planId: string,
  keep: number,
  db: ReturnType<typeof getDb> = getDb()
): Promise<void> {
  return db.agentPlanEvents
    .where("planId")
    .equals(planId)
    .count()
    .then((total) => {
      if (total <= keep) return
      const overflow = total - keep
      return db.agentPlanEvents
        .where("[planId+ts]")
        .between([planId, -Infinity], [planId, Infinity])
        .limit(overflow)
        .primaryKeys()
        .then((oldest) =>
          oldest.length > 0
            ? db.agentPlanEvents.bulkDelete(oldest as string[]).then(() => undefined)
            : undefined
        )
    })
}

/** Test-only escape hatch. */
export const __TESTING__ = { EVENTS_PER_PLAN_CAP, pruneEventsForPlan }
