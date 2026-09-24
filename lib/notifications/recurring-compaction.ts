/**
 * Fold the unread rows that recurring producers piled up before they started
 * coalescing (`COALESCE_UNTIL_ARCHIVED`) into one entry per source.
 *
 * The Tauri audit found "86 unread notifications" surviving every restart. The
 * producers now keep one updating row per recurring source, but the rows they
 * already wrote stay in Dexie until retention (30 days / 500 rows) ages them
 * out. This pass handles that backlog once per app process, before the center
 * first hydrates:
 *
 * - Rows are grouped by their recurring identity: a scheduled task's event
 *   (`task:<id>:<event>[:<executionId>]` → `task:<id>:<event>`) or a pet
 *   due reminder (`pet-scheduled-due:<taskId>`). Anything else is untouched.
 * - Only UNREAD rows (`unseen` / `seen`) that are not currently snoozed are
 *   folded. Read, archived, and snoozed rows are the user's own decisions.
 * - In each group the newest row survives: its `count` absorbs the folded
 *   rows' counts and its `dedupeKey` becomes the canonical recurring key, so
 *   the producer's next occurrence bumps it instead of adding a row.
 * - The other rows are ARCHIVED (`readState: "done"`), not deleted. They stay
 *   in Dexie and restorable, and retention removes them on its usual schedule.
 * - A background maintenance task's routine rows (start / progress /
 *   complete, and due reminders) are also marked read on the survivor: they
 *   were never news, and the producers no longer write them at all.
 *
 * Failures, auto-pauses, and user tasks keep an unread survivor, so nothing a
 * user needs to act on disappears from the badge.
 */

import type { NotificationRecord } from "@/types/notifications"
import type { ScheduledTask } from "@/types/scheduler"
import { cascadeReadState } from "./read-state"

const TASK_EVENT_KEY = /^task:(.+?):(start|progress|complete|error|auto-paused)(?::(.+))?$/
const DUE_KEY = /^pet-scheduled-due:(.+)$/
const ROUTINE_EVENTS = new Set(["start", "progress", "complete", "due"])

/** A recurring source a row belongs to. */
export interface RecurringIdentity {
  /** Canonical coalescing key the producer writes today. */
  key: string
  taskId: string
  event: "start" | "progress" | "complete" | "error" | "auto-paused" | "due"
}

/** Map a row to its recurring source, or `undefined` for anything else. */
export function recurringIdentityOf(
  record: Pick<NotificationRecord, "dedupeKey">
): RecurringIdentity | undefined {
  const key = record.dedupeKey
  if (!key) return undefined
  const task = TASK_EVENT_KEY.exec(key)
  if (task) {
    const [, taskId, event] = task
    return { key: `task:${taskId}:${event}`, taskId, event: event as RecurringIdentity["event"] }
  }
  const due = DUE_KEY.exec(key)
  if (due) return { key, taskId: due[1], event: "due" }
  return undefined
}

export type CompactionTask = Pick<ScheduledTask, "type" | "tags" | "trigger">

export interface CompactionPlanInput {
  records: readonly NotificationRecord[]
  now: number
  /** Resolved tasks by id; a missing entry means the task is gone or unknown. */
  tasks: ReadonlyMap<string, CompactionTask>
  isMaintenanceTask: (task: CompactionTask) => boolean
}

export interface CompactionPatch {
  id: string
  /** Guard: apply only if the row was not touched since it was read. */
  expectedUpdatedAt: number
  patch: Partial<NotificationRecord>
}

function isUnreadAndAwake(record: NotificationRecord, now: number): boolean {
  if (record.readState !== "unseen" && record.readState !== "seen") return false
  return record.snoozedUntil === undefined || record.snoozedUntil <= now
}

/** Pure planner: which rows to archive and how to update each survivor. */
export function planRecurringCompaction(input: CompactionPlanInput): CompactionPatch[] {
  const groups = new Map<string, { identity: RecurringIdentity; rows: NotificationRecord[] }>()
  for (const record of input.records) {
    if (!isUnreadAndAwake(record, input.now)) continue
    const identity = recurringIdentityOf(record)
    if (!identity) continue
    // A one-shot task's per-execution rows are distinct facts, not repeats.
    const task = input.tasks.get(identity.taskId)
    const groupKey = task?.trigger.type === "once" ? (record.dedupeKey as string) : identity.key
    const group = groups.get(groupKey) ?? { identity, rows: [] }
    group.rows.push(record)
    groups.set(groupKey, group)
  }

  const patches: CompactionPatch[] = []
  for (const [groupKey, { identity, rows }] of groups) {
    const sorted = [...rows].sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)
    const [survivor, ...folded] = sorted
    const task = input.tasks.get(identity.taskId)
    const routineMaintenance =
      task !== undefined && input.isMaintenanceTask(task) && ROUTINE_EVENTS.has(identity.event)

    const survivorPatch: Partial<NotificationRecord> = {}
    if (folded.length > 0) {
      survivorPatch.count = sorted.reduce((sum, row) => sum + Math.max(1, row.count ?? 1), 0)
    }
    if (survivor.dedupeKey !== groupKey) survivorPatch.dedupeKey = groupKey
    if (routineMaintenance)
      Object.assign(survivorPatch, cascadeReadState(survivor, "read", input.now))
    if (Object.keys(survivorPatch).length > 0) {
      patches.push({
        id: survivor.id,
        expectedUpdatedAt: survivor.updatedAt,
        patch: survivorPatch,
      })
    }
    for (const row of folded) {
      patches.push({
        id: row.id,
        expectedUpdatedAt: row.updatedAt,
        patch: {
          ...cascadeReadState(row, "done", input.now),
          meta: { ...(row.meta ?? {}), coalescedInto: survivor.id },
        },
      })
    }
  }
  return patches
}

export interface CompactionDeps {
  now: () => number
  listUnread: () => Promise<NotificationRecord[]>
  getTask: (taskId: string) => Promise<CompactionTask | null | undefined>
  isMaintenanceTask: (task: CompactionTask) => boolean
  /** Apply the patches atomically; returns how many were written. */
  applyPatches: (patches: readonly CompactionPatch[]) => Promise<number>
}

export interface CompactionResult {
  archived: number
  updated: number
}

/** Plan + apply one compaction pass. */
export async function compactRecurringNotifications(
  deps: CompactionDeps
): Promise<CompactionResult> {
  const records = await deps.listUnread()
  const taskIds = new Set<string>()
  for (const record of records) {
    const identity = recurringIdentityOf(record)
    if (identity) taskIds.add(identity.taskId)
  }
  const tasks = new Map<string, CompactionTask>()
  await Promise.all(
    [...taskIds].map(async (taskId) => {
      try {
        const task = await deps.getTask(taskId)
        if (task) tasks.set(taskId, task)
      } catch {
        // An unresolvable task only loses the maintenance read-marking; its
        // rows still fold.
      }
    })
  )
  const patches = planRecurringCompaction({
    records,
    now: deps.now(),
    tasks,
    isMaintenanceTask: deps.isMaintenanceTask,
  })
  if (patches.length === 0) return { archived: 0, updated: 0 }
  await deps.applyPatches(patches)
  const archived = patches.filter((entry) => entry.patch.readState === "done").length
  return { archived, updated: patches.length - archived }
}

async function defaultDeps(): Promise<CompactionDeps> {
  const [{ getDb }, { isMaintenanceTask }] = await Promise.all([
    import("@/lib/db/schema"),
    import("@/lib/scheduler/maintenance-tasks"),
  ])
  return {
    now: () => Date.now(),
    listUnread: () => getDb().notifications.where("readState").anyOf("unseen", "seen").toArray(),
    getTask: async (taskId) => {
      const { schedulerDb } = await import("@/lib/scheduler/scheduler-db")
      return schedulerDb.getTask(taskId)
    },
    isMaintenanceTask,
    applyPatches: async (patches) => {
      const table = getDb().notifications
      let written = 0
      await getDb().transaction("rw", table, async () => {
        for (const entry of patches) {
          const current = await table.get(entry.id)
          // Skip a row a producer or the user touched since it was read.
          if (!current || current.updatedAt !== entry.expectedUpdatedAt) continue
          written += await table.update(entry.id, entry.patch)
        }
      })
      return written
    },
  }
}

let compaction: Promise<CompactionResult> | null = null

/**
 * Run the backlog compaction once per app process. Never rejects: a failure
 * leaves the rows as they were (the producers still stop adding new ones).
 */
export function ensureRecurringNotificationsCompacted(
  deps?: CompactionDeps
): Promise<CompactionResult> {
  if (!compaction) {
    compaction = (async () => {
      try {
        return await compactRecurringNotifications(deps ?? (await defaultDeps()))
      } catch (error) {
        console.warn("notifications: recurring backlog compaction failed", error)
        return { archived: 0, updated: 0 }
      }
    })()
  }
  return compaction
}

/** Test hook: forget the once-per-process result. */
export function __resetRecurringCompactionForTesting(): void {
  compaction = null
}
