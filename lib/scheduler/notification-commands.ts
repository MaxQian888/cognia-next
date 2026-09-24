// Notification command handlers for scheduler-produced notifications
// (ADR-0042 action registry). `NotificationAction`s persist a command key plus
// serializable args; this module binds those keys to real work — navigation
// for `scheduler.open-task`, and writing `notification.dueReminder = false`
// for `scheduled-due.mute` (the flag `usePetScheduledReminder` checks before
// reminding again).
//
// Install once from a React root (`SchedulerInitializer`) so `navigate` can
// be the App Router's `router.push`; the module itself stays i18n-free and
// dependency-injected for tests, matching `installSiteNotificationCommands`.

import { registerNotificationCommand } from "@/lib/notifications/action-registry"
import type { ScheduledTask, UpdateScheduledTaskInput } from "@/types/scheduler"
import { parseUnifiedId } from "@/types/scheduler/unified"

/** Open the task's detail pane — `/scheduler?item=` is the selection address. */
export const SCHEDULER_OPEN_TASK_COMMAND = "scheduler.open-task"

/** Mute the pet's due reminder for one task (the toast's "Mute" action). */
export const SCHEDULED_DUE_MUTE_COMMAND = "scheduled-due.mute"

export interface ScheduledNotificationCommandDeps {
  navigate: (path: string) => void
  /** Defaults to `schedulerDb.getTask`. */
  getTask?: (taskId: string) => Promise<ScheduledTask | null>
  /**
   * Defaults to `useSchedulerStore.getState().updateTask` — the store path so
   * the write goes through the same data-source routing (local vs remote
   * daemon) and list refresh the scheduler page uses.
   */
  updateTask?: (taskId: string, input: UpdateScheduledTaskInput) => Promise<ScheduledTask | null>
}

async function defaultGetTask(taskId: string): Promise<ScheduledTask | null> {
  const { schedulerDb } = await import("@/lib/scheduler/scheduler-db")
  return schedulerDb.getTask(taskId)
}

async function defaultUpdateTask(
  taskId: string,
  input: UpdateScheduledTaskInput
): Promise<ScheduledTask | null> {
  // Lazy: `stores/scheduler` imports `lib/scheduler`, so a static edge here
  // would cycle the module graph.
  const { useSchedulerStore } = await import("@/stores/scheduler/scheduler-store")
  return useSchedulerStore.getState().updateTask(taskId, input)
}

/** Register the scheduler notification commands. Returns the unregister fn. */
export function installScheduledNotificationCommands(
  deps: ScheduledNotificationCommandDeps
): () => void {
  const getTask = deps.getTask ?? defaultGetTask
  const updateTask = deps.updateTask ?? defaultUpdateTask

  const offOpen = registerNotificationCommand(SCHEDULER_OPEN_TASK_COMMAND, (ctx) => {
    const taskId = ctx.args?.taskId
    if (typeof taskId !== "string" || taskId.length === 0) return
    // `itemId` is the record's canonical unifiedId — kind prefix included, so
    // plugin tasks resolve under `plugin:`. Records persisted before the arg
    // existed fall back to `app:`, the dominant kind.
    const itemId =
      typeof ctx.args?.itemId === "string" && parseUnifiedId(ctx.args.itemId)
        ? ctx.args.itemId
        : `app:${taskId}`
    deps.navigate(`/scheduler?item=${encodeURIComponent(itemId)}`)
  })

  const offMute = registerNotificationCommand(SCHEDULED_DUE_MUTE_COMMAND, async (ctx) => {
    const taskId = ctx.args?.taskId
    if (typeof taskId !== "string" || taskId.length === 0) return
    const task = await getTask(taskId)
    if (!task) return
    // `notification` replaces wholesale on update, so merge the existing
    // config rather than writing `{ dueReminder: false }` alone — that would
    // wipe onStart/onComplete/channels.
    await updateTask(taskId, {
      notification: { ...task.notification, dueReminder: false },
    })
  })

  return () => {
    offOpen()
    offMute()
  }
}
