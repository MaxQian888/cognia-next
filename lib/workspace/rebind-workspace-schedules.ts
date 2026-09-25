/**
 * Hand a removed workspace's schedules to wherever its conversations went.
 *
 * Schedules live in the scheduler's own store, outside `PROJECT_SCOPED_TABLES`,
 * so removing a workspace used to leave every schedule it owned pointing at an
 * id that no longer existed. `taskVisibleInWorkspace` only lets an UNBOUND task
 * through, so those rows were hidden from every workspace at once: still
 * firing, never listed, uncorrectable.
 *
 * The target follows the removal mode:
 * - detach: the fallback workspace, the same place the conversations landed,
 *   so a schedule stays next to the conversation it posts into.
 * - delete-data: `null`. The conversations those schedules belonged to are
 *   gone, and an unbound schedule is listed in every workspace, which is where
 *   the user can see it and decide. Deleting a schedule is not a side effect
 *   this dialog promises.
 *
 * A schedule that froze an execution binding naming the removed workspace
 * (`payload.executionContext`, migrated rows) loses it too, as the
 * workspace's conversations lose theirs in `detachProjectContents`. A chat
 * run resolves its owning workspace from that binding before the task's own
 * `projectId`, so leaving it would keep every fire attributed to a workspace
 * that no longer exists.
 *
 * The write goes through `TaskScheduler.updateTask`, the path the task detail
 * panel uses, so `null` means "unbind" exactly the way it does there, and the
 * payload is merged, so only the binding is cleared.
 */

import type { ScheduledTask, UpdateScheduledTaskInput } from "@/types/scheduler"

type RebindableTask = Pick<ScheduledTask, "id" | "projectId"> & {
  payload?: ScheduledTask["payload"]
}

export interface RebindWorkspaceSchedulesDeps {
  /** Every task bound to `projectId` (unbound tasks may be included; they are skipped). */
  listTasks: (projectId: string) => Promise<RebindableTask[]>
  updateTask: (
    taskId: string,
    input: Pick<UpdateScheduledTaskInput, "projectId" | "payload">
  ) => Promise<unknown>
}

/** Whether the task's frozen execution binding names `projectId`. */
function bindingNames(task: RebindableTask, projectId: string): boolean {
  const context = (task.payload as { executionContext?: { projectId?: unknown } } | undefined)
    ?.executionContext
  return context?.projectId === projectId
}

async function defaultDeps(): Promise<RebindWorkspaceSchedulesDeps> {
  const [{ schedulerDb }, { getTaskScheduler }] = await Promise.all([
    import("@/lib/scheduler/scheduler-db"),
    import("@/lib/scheduler/task-scheduler"),
  ])
  return {
    listTasks: (projectId) => schedulerDb.getTasksByProject(projectId),
    updateTask: (taskId, input) => getTaskScheduler().updateTask(taskId, input),
  }
}

/**
 * Re-point every schedule owned by `fromProjectId`. Returns how many moved.
 * Throws on the first failed write so the caller can keep the workspace row
 * and let the user retry; a rebind that already landed is a no-op next time.
 */
export async function rebindWorkspaceSchedules(
  fromProjectId: string,
  toProjectId: string | null,
  deps?: RebindWorkspaceSchedulesDeps
): Promise<number> {
  const { listTasks, updateTask } = deps ?? (await defaultDeps())
  const owned = (await listTasks(fromProjectId)).filter((task) => task.projectId === fromProjectId)
  for (const task of owned) {
    await updateTask(task.id, {
      projectId: toProjectId,
      ...(bindingNames(task, fromProjectId) ? { payload: { executionContext: undefined } } : {}),
    })
  }
  return owned.length
}
