/**
 * Subsystem-owned schedule lifecycle. Storage-only bridges cannot arm a clock.
 * Shared here by cron bridges and maintenance installers; notification policy
 * stays in the pure maintenance classifier used by notification producers.
 */
import type { CreateScheduledTaskInput, ScheduledTask } from "@/types/scheduler"
import type { TaskSchedulerImpl } from "./task-scheduler"
import { SchedulerError } from "./errors"
import {
  isSilentMaintenanceType,
  maintenanceNotificationPatch,
  SILENT_MAINTENANCE_NOTIFICATION,
  isRetiredMaintenanceTask,
  RETIRED_MAINTENANCE_TAG,
} from "./maintenance-tasks"

type Scheduler = Pick<TaskSchedulerImpl, "getAllTasks" | "createTask" | "updateTask">
const installs = new WeakMap<Scheduler, Map<string, Promise<void>>>()

function eligible(task: ScheduledTask, type: string): boolean {
  return (
    task.type === type &&
    task.owner?.kind !== "remote-host" &&
    (!task.createdBy || task.createdBy.kind === "user") &&
    !isRetiredMaintenanceTask(task)
  )
}

/** Save settings immediately into the live clock, retaining history and manual pauses. */
export async function saveManagedTask(
  scheduler: Scheduler,
  next: ScheduledTask,
  existing: ScheduledTask | null
): Promise<void> {
  if (!existing) {
    await scheduler.createTask(next)
    return
  }
  await scheduler.updateTask(next.id, {
    name: next.name,
    description: next.description,
    trigger: next.trigger,
    payload: next.payload,
    notification: next.notification,
    tags: next.tags,
  })
}

/** One local singleton per type. Retired duplicates retain their executions. */
export function ensureMaintenanceSchedule(
  scheduler: Scheduler,
  draft: CreateScheduledTaskInput
): Promise<void> {
  let pending = installs.get(scheduler)
  if (!pending) installs.set(scheduler, (pending = new Map()))
  const current = pending.get(draft.type)
  if (current) return current
  const install = reconcileMaintenanceSchedule(scheduler, draft).finally(() => {
    pending.delete(draft.type)
  })
  pending.set(draft.type, install)
  return install
}

async function reconcileMaintenanceSchedule(
  scheduler: Scheduler,
  draft: CreateScheduledTaskInput
): Promise<void> {
  const all = await scheduler.getAllTasks()
  const id = `system:${draft.type}`
  const reserved = all.find((task) => task.id === id)
  if (reserved && !eligible(reserved, draft.type)) {
    throw new SchedulerError("MAINTENANCE_IDENTITY_COLLISION", "Maintenance identity is occupied", {
      taskId: id,
    })
  }
  const rows = all
    .filter((task) => eligible(task, draft.type))
    .sort((a, b) => {
      // A manual pause wins over an accidentally duplicated active row.
      const inactive = Number(a.status === "active") - Number(b.status === "active")
      return inactive || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)
    })
  const [canonical, ...duplicates] = rows
  if (!canonical) {
    try {
      await scheduler.createTask({ ...draft, id, notification: SILENT_MAINTENANCE_NOTIFICATION })
    } catch (error) {
      // A second window may have won the unique primary-key insert. Other
      // failures (including a failed arm after insert) must remain visible.
      if (!(error instanceof Error) || error.name !== "ConstraintError") throw error
      const winner = (await scheduler.getAllTasks()).find((task) => task.id === id)
      if (!winner) throw error
      if (!eligible(winner, draft.type)) {
        throw new SchedulerError(
          "MAINTENANCE_IDENTITY_COLLISION",
          "Maintenance identity is occupied",
          { taskId: id }
        )
      }
      await scheduler.updateTask(id, {})
    }
    return
  }
  const patch = maintenanceNotificationPatch(canonical.notification)
  if (patch) await scheduler.updateTask(canonical.id, { notification: patch })
  for (const duplicate of duplicates) {
    await scheduler.updateTask(duplicate.id, {
      status: "disabled",
      notification: SILENT_MAINTENANCE_NOTIFICATION,
      tags: [...(duplicate.tags ?? []), RETIRED_MAINTENANCE_TAG, `duplicate-of:${canonical.id}`],
    })
  }
}

/** Adopt old default-toast rows too, including adapter schedules not reinstalled on this boot. */
export async function reconcileMaintenanceNotifications(
  scheduler: Scheduler,
  isCurrent: () => boolean = () => true
): Promise<void> {
  for (const task of await scheduler.getAllTasks()) {
    if (!isCurrent()) return
    if (task.owner?.kind === "remote-host") continue
    if (!isSilentMaintenanceType(task.type)) continue
    const patch = maintenanceNotificationPatch(task.notification)
    if (patch) await scheduler.updateTask(task.id, { notification: patch })
  }
}
