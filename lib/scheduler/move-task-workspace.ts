/**
 * Move a scheduled task to a different Workspace.
 *
 * `ScheduledTask.projectId` decides which workspace a schedule is listed under
 * and which execution root it resolves. It was resolved once at creation and
 * nothing could change it afterwards, so a schedule attributed to the wrong
 * workspace was invisible from every other one and uncorrectable from the one
 * that owned it.
 *
 * Unlike a conversation, a task carries no durable execution context to
 * rebuild: the payload's own `cwd`, where it has one, is the user's text and is
 * deliberately left alone. Re-binding therefore writes exactly one field.
 *
 * # Why an OS promotion is NOT a refusal
 *
 * `ScheduledTaskPromotion` records only `systemTaskId`, `token`, `promotedAt`
 * and `backend`. The OS task fires a deep link back into the app, which then
 * resolves the execution root from the task as it stands. No path is baked
 * into the OS entry, so a promoted task survives a move unchanged and refusing
 * one would be superstition.
 *
 * # Why a remote host IS a refusal
 *
 * Workspace ids are local. `projects` is absent from `COMPANION_SYNC_TABLES`
 * and `activeProjectId` is categorised `desktop-only` in the settings-sync
 * map, so an id picked from this device names nothing on a paired host.
 * Writing one into that host's schedule would replace a correct binding with a
 * meaningless string.
 */

import type { Project } from "@/types"
import type { ScheduledTask } from "@/types/scheduler"

export type MoveTaskRefusal =
  "same-workspace" | "unknown-workspace" | "remote-host" | "task-running"

export interface MoveTaskInput {
  task: Pick<ScheduledTask, "id" | "projectId" | "status">
  /** The destination, or null to clear the binding. */
  target: Pick<Project, "id"> | null
  /**
   * True when the schedule being edited belongs to a paired host rather than
   * this device. See the header.
   */
  remoteHost: boolean
  /** True while an execution of this task is in flight. */
  running: boolean
}

export type MoveTaskPlan =
  | { ok: false; reason: MoveTaskRefusal }
  /** `projectId: null` clears the binding, matching `UpdateScheduledTaskInput`. */
  | { ok: true; projectId: string | null; previousProjectId?: string }

/**
 * Decide the move. Pure: the caller performs the update, so every refusal is
 * testable without a scheduler or a database.
 */
export function planTaskMove(input: MoveTaskInput): MoveTaskPlan {
  const { task, target, remoteHost, running } = input

  if (remoteHost) return { ok: false, reason: "remote-host" }
  // Clearing an already-unbound task, or re-picking the workspace it is in,
  // is a no-op the caller should not spend a write on.
  if ((task.projectId ?? null) === (target?.id ?? null)) {
    return { ok: false, reason: "same-workspace" }
  }
  // A run in flight resolves its root from the task. Re-pointing underneath it
  // would send the rest of that execution somewhere the user did not choose.
  if (running) return { ok: false, reason: "task-running" }

  return {
    ok: true,
    projectId: target?.id ?? null,
    ...(task.projectId ? { previousProjectId: task.projectId } : {}),
  }
}
