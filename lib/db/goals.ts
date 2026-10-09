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
import { recordTombstones } from "@/lib/sync/tombstones"
import { DEFAULT_PROJECT_ID, resolveSessionProjectId } from "./project-scope"
import { getSettings } from "./settings"

/**
 * Newest events kept per goal. Exported because a paired client's mirror of
 * the log (`lib/sync/handlers/goals.ts`) prunes to the same cap, so the two
 * windows match without a delete crossing the wire.
 */
export const EVENTS_PER_GOAL_CAP = 5000

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
  // Preserve the liveQuery observation scope across settings' native async
  // helpers. A native await here can drop the later goal query from that scope,
  // leaving the console on its initial snapshot after a successful mutation.
  const database = getDb()
  const scope =
    projectId === undefined
      ? Dexie.Promise.resolve(getSettings()).then(
          (settings) => settings.activeProjectId ?? DEFAULT_PROJECT_ID
        )
      : Dexie.Promise.resolve(projectId)
  return scope.then((pid) => {
    if (getDb() !== database) throw new Dexie.AbortError("Goal query database changed")
    return database.chatGoals
      .where("[projectId+createdAt]")
      .between([pid, Dexie.minKey], [pid, Dexie.maxKey])
      .reverse()
      .limit(limit)
      .toArray()
  })
}

/**
 * The active workspace's id, read inside a liveQuery without leaving its
 * observation scope. Same reasoning as {@link listAllGoals}.
 */
function activeGoalScope(projectId: string | undefined) {
  return projectId === undefined
    ? Dexie.Promise.resolve(getSettings()).then(
        (settings) => settings.activeProjectId ?? DEFAULT_PROJECT_ID
      )
    : Dexie.Promise.resolve(projectId)
}

/**
 * Every goal that can still move (`active` / `paused`) in one workspace,
 * newest first — however old. The Overview used to filter these out of
 * {@link listAllGoals}'s newest-500 window, so an open goal created before the
 * 500 most recent ones silently left the console while it kept running. The
 * `status` index bounds this read by open goals, not by history depth.
 */
export async function listOpenGoals(projectId?: string): Promise<Goal[]> {
  const database = getDb()
  return activeGoalScope(projectId).then((pid) => {
    if (getDb() !== database) throw new Dexie.AbortError("Goal query database changed")
    return database.chatGoals
      .where("status")
      .anyOf(["active", "paused"])
      .filter((goal) => goal.projectId === pid)
      .toArray()
      .then((rows) => rows.sort((a, b) => b.createdAt - a.createdAt))
  })
}

/** How many goals one workspace holds — what History's "Load more" counts toward. */
export async function countAllGoals(projectId?: string): Promise<number> {
  const database = getDb()
  return activeGoalScope(projectId).then((pid) => {
    if (getDb() !== database) throw new Dexie.AbortError("Goal query database changed")
    return database.chatGoals
      .where("[projectId+createdAt]")
      .between([pid, Dexie.minKey], [pid, Dexie.maxKey])
      .count()
  })
}

/**
 * Every goal attached to any of `sessionIds`, newest first. Not workspace
 * scoped: the conversation manager lists every workspace's conversations and
 * marks the ones running a goal.
 */
export async function listGoalsForSessions(sessionIds: readonly string[]): Promise<Goal[]> {
  if (sessionIds.length === 0) return []
  const rows = await getDb()
    .chatGoals.where("sessionId")
    .anyOf([...sessionIds])
    .toArray()
  return rows.sort((a, b) => b.createdAt - a.createdAt)
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
      await db.transaction("rw", db.chatGoals, db.chatGoalEvents, db.syncTombstones, async () => {
        await Promise.all([
          db.chatGoalEvents.where("goalId").equals(id).delete(),
          db.chatGoals.delete(id),
          // Paired clients mirror goals as `goals` and hear about a delete
          // only through this tombstone.
          recordTombstones("goals", [id]),
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
  await db.transaction("rw", db.chatGoals, db.chatGoalEvents, db.syncTombstones, async () => {
    const goalIds = await db.chatGoals.where("sessionId").equals(sessionId).primaryKeys()
    if (goalIds.length === 0) return
    await db.chatGoalEvents
      .where("goalId")
      .anyOf(goalIds as string[])
      .delete()
    await db.chatGoals.bulkDelete(goalIds as string[])
    await recordTombstones("goals", goalIds as string[])
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
 * The latest judge verdict's reason for each goal that has one. One read for
 * a whole list: each goal's events are walked newest first and stop at the
 * first `judge_evaluated`, so the cost is the events since the last verdict,
 * not the goal's history. The console used to open one live query per card
 * to find the same thing.
 */
export async function latestJudgeReasons(goalIds: readonly string[]): Promise<Map<string, string>> {
  const db = getDb()
  const entries = await Promise.all(
    goalIds.map(async (goalId) => {
      const event = await db.chatGoalEvents
        .where("[goalId+ts]")
        .between([goalId, -Infinity], [goalId, Infinity])
        .reverse()
        .filter((ev) => ev.kind === "judge_evaluated")
        .first()
      return event?.payload.kind === "judge_evaluated"
        ? ([goalId, event.payload.reason] as const)
        : null
    })
  )
  return new Map(entries.filter((entry): entry is readonly [string, string] => entry !== null))
}

/**
 * Number of events on file for a goal. Used by the Activity tab badge.
 */
export async function countGoalEvents(goalId: string): Promise<number> {
  return getDb().chatGoalEvents.where("goalId").equals(goalId).count()
}

/**
 * Trim each goal in `goalIds` back to its newest `keep` events, in one
 * transaction. The host trims on every append; a paired client that mirrors
 * the log calls this after applying a pulled page, so the host's per-goal
 * prune (which records no tombstones) is mirrored by the same rule.
 */
export async function pruneGoalEvents(
  goalIds: readonly string[],
  keep: number = EVENTS_PER_GOAL_CAP
): Promise<void> {
  const unique = [...new Set(goalIds)]
  if (unique.length === 0) return
  const db = getDb()
  await db.transaction("rw", db.chatGoalEvents, async () => {
    for (const goalId of unique) await pruneEventsForGoal(goalId, keep, db)
  })
}

/**
 * Remove every event of the given goals. The paired client's half of the
 * cascade {@link deleteGoal} performs on the host: a goal deletion reaches the
 * client as a `goals` tombstone, and its events have to go with it.
 */
export async function deleteGoalEventsForGoals(goalIds: readonly string[]): Promise<void> {
  if (goalIds.length === 0) return
  await getDb()
    .chatGoalEvents.where("goalId")
    .anyOf([...goalIds])
    .delete()
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
