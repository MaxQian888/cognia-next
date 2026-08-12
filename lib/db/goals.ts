/**
 * CRUD for the `chatGoals` and `chatGoalEvents` tables (schema v30).
 *
 * Writer enforces the **session-scoped uniqueness invariant**: at most one
 * row per `sessionId` can carry `status==="active"`. Callers that promote a
 * paused goal back to active, or create a new goal while one is already
 * active, MUST first transition the prior active goal to a terminal/paused
 * status. Helpers in `lib/goal/runtime.ts` use the seven-exit machinery for
 * that — this module stays mechanical.
 *
 * Events are append-only and capped at 5000 newest per goal via
 * `EVENTS_PER_GOAL_CAP`. The cap is per-goal (not global) so a long-lived
 * goal can't starve another goal's audit trail.
 */

import Dexie from "dexie"
import type { Goal, GoalEvent, GoalEventKind, GoalEventPayload, GoalStatus } from "@/types/goal"
import { isTerminalGoalStatus } from "@/types/goal"
import { getDb, withDbReopenRetry } from "./schema"
import { DEFAULT_PROJECT_ID, resolveSessionProjectId } from "./project-scope"
import { getSettings } from "./settings"

const EVENTS_PER_GOAL_CAP = 5000

// ─────────────────────────────────────────────────────────────────────────────
// Goal CRUD
// ─────────────────────────────────────────────────────────────────────────────

export type GoalCreateInput = Omit<Goal, "createdAt" | "updatedAt" | "endedAt">

/**
 * Insert a fresh goal row. Caller is responsible for ensuring no other row
 * with the same `sessionId` has `status==="active"` — typically by calling
 * `getActiveGoalForSession` first and transitioning it away.
 */
export async function createGoal(input: GoalCreateInput): Promise<Goal> {
  const now = Date.now()
  // Inherit the session's workspace (Workspace isolation, Dexie v86).
  const projectId = await resolveSessionProjectId(input.sessionId, input.projectId)
  const row: Goal = {
    ...input,
    projectId,
    createdAt: now,
    updatedAt: now,
  }
  await getDb().chatGoals.add(row)
  return row
}

export async function getGoal(id: string): Promise<Goal | undefined> {
  return getDb().chatGoals.get(id)
}

/**
 * Return the single active goal for a session, or undefined. Index-backed by
 * `[sessionId+status]` so this is O(log n) regardless of history depth.
 */
export async function getActiveGoalForSession(sessionId: string): Promise<Goal | undefined> {
  return getDb().chatGoals.where("[sessionId+status]").equals([sessionId, "active"]).first()
}

/** Same as `getActiveGoalForSession` but matches "active" OR "paused". */
export async function getOpenGoalForSession(sessionId: string): Promise<Goal | undefined> {
  const db = getDb()
  const active = await db.chatGoals
    .where("[sessionId+status]")
    .equals([sessionId, "active"])
    .first()
  if (active) return active
  return db.chatGoals.where("[sessionId+status]").equals([sessionId, "paused"]).first()
}

/**
 * Newest-first list of all goals for a session (active, paused, and terminal).
 * Used by the Sheet's history dropdown and the Settings → Goals → History tab.
 */
export async function listGoalsBySession(sessionId: string): Promise<Goal[]> {
  return getDb().chatGoals.where("sessionId").equals(sessionId).reverse().sortBy("createdAt")
}

/**
 * Newest-first list of all goals in one workspace (defaults to the active
 * project via the central scope helper). Used by the Goal console and the
 * Settings → Goals → History tab — both working-set surfaces, so they show
 * only the current workspace's goals. Uses the `[projectId+createdAt]`
 * compound index (Dexie v86).
 */
export async function listAllGoals(limit = 500, projectId?: string): Promise<Goal[]> {
  // This reader is called from Dexie liveQuery surfaces. Falling back through
  // resolveScopeProjectId would auto-create Default and write settings inside
  // the liveQuery's read-only context on first boot. The project initializer
  // owns that write; until it finishes, an empty Default-scoped read is safe.
  const pid = projectId ?? (await getSettings()).activeProjectId ?? DEFAULT_PROJECT_ID
  return getDb()
    .chatGoals.where("[projectId+createdAt]")
    .between([pid, Dexie.minKey], [pid, Dexie.maxKey])
    .reverse()
    .limit(limit)
    .toArray()
}

export interface GoalUpdatePatch {
  status?: GoalStatus
  turnsUsed?: number
  tokensUsed?: number
  judgeFailureCount?: number
  rawObjective?: string
  safeObjective?: string
  redactionMapEnc?: string
  config?: Goal["config"]
  generationId?: string
  endedAt?: number
  subgoals?: Goal["subgoals"]
  subgoalsGeneratedAt?: number
  awaitingPromise?: boolean
  awaitingAcceptance?: boolean
  promiseDenialCount?: number
  nextContinuationAt?: number
  nextContinuationSource?: Goal["nextContinuationSource"]
  verification?: Goal["verification"]
}

/**
 * Apply a partial patch to a goal. Always bumps `updatedAt`. When the patch
 * transitions the status into a terminal state, `endedAt` is back-filled
 * automatically if the caller didn't supply one.
 */
export async function updateGoal(id: string, patch: GoalUpdatePatch): Promise<void> {
  const now = Date.now()
  const next: Partial<Goal> = { ...patch, updatedAt: now }
  if (patch.status && isTerminalGoalStatus(patch.status) && patch.endedAt == null) {
    next.endedAt = now
  }
  await getDb().chatGoals.update(id, next)
}

/**
 * Cascade-delete: drop the goal AND every event for it. Done in a
 * single transaction so a crash mid-delete can't leave orphans.
 */
export async function deleteGoal(id: string): Promise<void> {
  try {
    await withDbReopenRetry(async () => {
      const db = getDb()
      await db.transaction("rw", db.chatGoals, db.chatGoalEvents, async () => {
        await Promise.all([
          db.chatGoalEvents.where("goalId").equals(id).delete(),
          db.chatGoals.delete(id),
        ])
      })
    })
  } catch (error) {
    // A premature-commit report can arrive after both deletes committed. Only
    // accept that race as success when the complete cascade is durable.
    const db = getDb()
    const [goal, eventCount] = await Promise.all([
      db.chatGoals.get(id),
      db.chatGoalEvents.where("goalId").equals(id).count(),
    ])
    if (goal || eventCount > 0) throw error
  }
}

/**
 * Cascade-delete every goal (and its events) for a given session. Used by
 * the session-delete path so terminated sessions don't leave dangling goal
 * rows.
 */
export async function deleteGoalsForSession(sessionId: string): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.chatGoals, db.chatGoalEvents, async () => {
    const goalIds = await db.chatGoals.where("sessionId").equals(sessionId).primaryKeys()
    if (goalIds.length === 0) return
    await db.chatGoalEvents
      .where("goalId")
      .anyOf(goalIds as string[])
      .delete()
    await db.chatGoals.bulkDelete(goalIds as string[])
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Event log
// ─────────────────────────────────────────────────────────────────────────────

export interface AppendEventInput {
  goalId: string
  kind: GoalEventKind
  payload: GoalEventPayload
  /** Pre-existing timestamp (test fixtures). Defaults to `Date.now()`. */
  ts?: number
  /** Pre-existing id (test fixtures). Defaults to a fresh UUIDv4. */
  id?: string
}

/**
 * Append a lifecycle event for a goal. Runs in a transaction together with
 * the per-goal cap-prune so the table can't blow up under heavy looping.
 */
export async function appendGoalEvent(input: AppendEventInput): Promise<GoalEvent> {
  let row: GoalEvent | undefined
  await withDbReopenRetry(() => {
    const db = getDb()
    return db.transaction("rw", db.chatGoalEvents, () =>
      db.chatGoalEvents
        .where("[goalId+ts]")
        .between([input.goalId, -Infinity], [input.goalId, Infinity])
        .reverse()
        .first()
        .then((newest) => {
          const ts = input.ts ?? Math.max(Date.now(), (newest?.ts ?? -1) + 1)
          row = {
            id: input.id ?? crypto.randomUUID(),
            goalId: input.goalId,
            kind: input.kind,
            ts,
            payload: input.payload,
          }
          return db.chatGoalEvents
            .put(row)
            .then(() => pruneEventsForGoal(input.goalId, EVENTS_PER_GOAL_CAP, db))
        })
    )
  })
  if (!row) throw new Error("Failed to append goal event")
  return row
}

/**
 * Newest-first list of events for a goal. Capped by `limit` (default 200).
 */
export async function listGoalEvents(goalId: string, limit = 200): Promise<GoalEvent[]> {
  const collection = getDb()
    .chatGoalEvents.where("[goalId+ts]")
    .between([goalId, -Infinity], [goalId, Infinity])
    .reverse()
  if (limit > 0) collection.limit(limit)
  return collection.toArray()
}

/**
 * Number of events on file for a goal. Used by the Activity tab badge.
 */
export async function countGoalEvents(goalId: string): Promise<number> {
  return getDb().chatGoalEvents.where("goalId").equals(goalId).count()
}

/**
 * Prune oldest events for a single goal so it holds at most `keep` entries.
 * Caller wraps in a transaction.
 */
function pruneEventsForGoal(
  goalId: string,
  keep: number,
  db: ReturnType<typeof getDb> = getDb()
): Promise<void> {
  return db.chatGoalEvents
    .where("goalId")
    .equals(goalId)
    .count()
    .then((total) => {
      if (total <= keep) return
      const overflow = total - keep
      return db.chatGoalEvents
        .where("[goalId+ts]")
        .between([goalId, -Infinity], [goalId, Infinity])
        .limit(overflow)
        .primaryKeys()
        .then((oldest) =>
          oldest.length > 0
            ? db.chatGoalEvents.bulkDelete(oldest as string[]).then(() => undefined)
            : undefined
        )
    })
}

/** Test-only escape hatch. */
export const __TESTING__ = { EVENTS_PER_GOAL_CAP, pruneEventsForGoal }
