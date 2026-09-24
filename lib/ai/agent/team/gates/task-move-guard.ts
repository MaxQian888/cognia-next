/**
 * Guarded task-move semantics for the team task board (kanban).
 *
 * `canMoveTask` is the SINGLE source of truth for which status transitions a
 * human (or an actor on the human's behalf) may perform on a team task. It is
 * shared by:
 *   - the desktop board's drag-and-drop (illegal drop targets grey out at
 *     drag start via `allowedMoveTargets`),
 *   - the mobile board's action-sheet moves (Companion RPC `team_task_move`),
 *   - the plugin `ctx.team.moveTask` API.
 *
 * Ownership model behind the rules:
 *   - `blocked` is dependency-derived — cards enter/leave it automatically,
 *     never by hand.
 *   - `claimed` / `in_progress` belong to the runtime while a run is active
 *     (`executing` / `planning`); when the team is at rest they may be pushed
 *     back to `pending` (e.g. after a pause left them stranded).
 *   - `pending → cancelled` (drop a task), `review → completed | failed`
 *     (human review verdict), and `failed → pending` (manual retry,
 *     ADR-0022's deferred retry surface) are the human-owned transitions.
 *   - Same-column moves (reordering) are always allowed.
 */

import type { AgentTeamTask, TeamStatus, TeamTaskStatus } from "@/types/agent/agent-team"

/** Why a move was denied — keyed for i18n at the UI layer. */
export type TaskMoveDenial =
  | "blocked-column" // blocked is dependency-derived, read-only
  | "runtime-owned" // claimed/in_progress touched while the run is active
  | "illegal-transition" // not in the human-owned transition set

export type TaskMoveVerdict = { allowed: true } | { allowed: false; reason: TaskMoveDenial }

/** Store/RPC-level move failure: a guard denial or a missing task. */
export type TaskMoveError = TaskMoveDenial | "task-not-found"

/** Team statuses during which the runtime owns claimed/in_progress tasks. */
const RUNTIME_ACTIVE_TEAM_STATUSES: ReadonlySet<TeamStatus> = new Set(["planning", "executing"])

const ALL_TASK_STATUSES: readonly TeamTaskStatus[] = [
  "pending",
  "blocked",
  "claimed",
  "in_progress",
  "review",
  "completed",
  "failed",
  "cancelled",
]

/**
 * Decide whether a task may be moved `from` → `to` given the team's current
 * status. `from` is passed explicitly (rather than read off `task.status`) so
 * callers validating a stale snapshot (RPC round-trips) surface the mismatch
 * at their own layer.
 */
export function canMoveTask(
  task: Pick<AgentTeamTask, "id" | "dependencies">,
  from: TeamTaskStatus,
  to: TeamTaskStatus,
  teamStatus: TeamStatus
): TaskMoveVerdict {
  // Same-column: reordering — always fine.
  if (from === to) return { allowed: true }

  // `blocked` is machine-managed on both ends.
  if (from === "blocked" || to === "blocked") {
    return { allowed: false, reason: "blocked-column" }
  }

  const runtimeActive = RUNTIME_ACTIVE_TEAM_STATUSES.has(teamStatus)

  // Runtime-owned columns: hands off while a run is active; at rest they may
  // only be pushed back to pending (unstranding after a pause/abort).
  if (from === "claimed" || from === "in_progress") {
    if (runtimeActive) return { allowed: false, reason: "runtime-owned" }
    if (to === "pending") return { allowed: true }
    return { allowed: false, reason: "illegal-transition" }
  }
  if (to === "claimed" || to === "in_progress") {
    return { allowed: false, reason: runtimeActive ? "runtime-owned" : "illegal-transition" }
  }

  // Human-owned transitions.
  if (from === "pending" && to === "cancelled") return { allowed: true }
  if (from === "review" && (to === "completed" || to === "failed")) return { allowed: true }
  if (from === "failed" && to === "pending") return { allowed: true }

  return { allowed: false, reason: "illegal-transition" }
}

/**
 * All statuses the task may currently be moved to (excluding its own column,
 * which is always a legal reorder target). Drives dnd-kit droppable disabling
 * and the mobile action sheet.
 */
export function allowedMoveTargets(
  task: Pick<AgentTeamTask, "id" | "dependencies" | "status">,
  teamStatus: TeamStatus
): TeamTaskStatus[] {
  return ALL_TASK_STATUSES.filter(
    (to) => to !== task.status && canMoveTask(task, task.status, to, teamStatus).allowed
  )
}

/**
 * Pure same-column reorder: move `taskId` to `targetIndex` within `column`
 * (the column's tasks in current visual order) and renumber `order` 0..n-1.
 * Returns only the entries whose `order` actually changed, ready for a store
 * write. Unknown ids and out-of-range indexes are clamped/no-oped.
 */
export function reorderColumn(
  column: ReadonlyArray<Pick<AgentTeamTask, "id" | "order">>,
  taskId: string,
  targetIndex: number
): Array<{ id: string; order: number }> {
  const fromIndex = column.findIndex((t) => t.id === taskId)
  if (fromIndex === -1) return []
  const clamped = Math.max(0, Math.min(targetIndex, column.length - 1))
  if (clamped === fromIndex && column.every((t, i) => t.order === i)) return []

  const ids = column.map((t) => t.id)
  ids.splice(fromIndex, 1)
  ids.splice(clamped, 0, taskId)

  const changes: Array<{ id: string; order: number }> = []
  const orderById = new Map(column.map((t) => [t.id, t.order]))
  ids.forEach((id, index) => {
    if (orderById.get(id) !== index) changes.push({ id, order: index })
  })
  return changes
}

/** Stable visual order for a column: by `order`, then creation time, then id. */
export function sortColumn<T extends Pick<AgentTeamTask, "id" | "order" | "createdAt">>(
  tasks: readonly T[]
): T[] {
  return [...tasks].sort(
    (a, b) =>
      a.order - b.order ||
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
      a.id.localeCompare(b.id)
  )
}
