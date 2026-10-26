/**
 * Which scheduled tasks are the app's own background maintenance.
 *
 * These tasks are created and re-created by subsystems, never by the user, and
 * they fire on short intervals: connector presence refresh every few minutes,
 * provider diagnostics every five, the daily housekeeping fan-out. A routine
 * success of one of them is not news. Before this classifier existed, the
 * presence refresh inherited the scheduler's default notification config
 * (`onComplete: true`, toast) and wrote a "Task Completed" row every tick —
 * part of the "86 unread notifications" the Tauri audit found.
 *
 * The rule is stated once so every notification producer agrees:
 * - `provider-diagnostics-refresh`
 * - `conversation-auto-archive`
 * - `files-trash-purge`
 * - `harness-evolution-sweep`
 * - every connector-owned `connection:housekeeping:*` type
 * - `connection:presence:refresh`
 * - any task tagged `system:<owner>` (housekeeping, provider diagnostics, bot
 *   timed triggers carry such a tag)
 *
 * User-configured connector schedules (`connection:scheduled:digest`,
 * `connection:outbound:send`) are deliberately NOT maintenance: they send
 * something the user asked for, so their outcomes stay user-visible.
 */

import type { ScheduledTask, TaskNotificationConfig } from "@/types/scheduler"

export const MAINTENANCE_TASK_TYPES: readonly string[] = Object.freeze([
  "provider-diagnostics-refresh",
  "conversation-auto-archive",
  "files-trash-purge",
  "harness-evolution-sweep",
  "connection:presence:refresh",
  "github-issue-sync",
])

export const MAINTENANCE_TASK_TYPE_PREFIX = "connection:housekeeping:"
export const SYSTEM_TASK_TAG_PREFIX = "system:"
export const RETIRED_MAINTENANCE_TAG = "system:maintenance-duplicate"

export function isRetiredMaintenanceTask(task: Pick<ScheduledTask, "tags">): boolean {
  return task.tags?.includes(RETIRED_MAINTENANCE_TAG) ?? false
}

/** Passive diagnostics retain every failure; ambient surfaces respect delivery choices. */
export function allowsMaintenanceAttention(
  task: Pick<ScheduledTask, "type" | "notification">
): boolean {
  if (!isSilentMaintenanceType(task.type)) return true
  const notification = task.notification
  if (!notification) return false
  if (notification.dueReminder === true) return true
  const effective = { ...notification, ...maintenanceNotificationPatch(notification) }
  return (
    effective.channels?.some((channel) => channel !== "none") === true &&
    !!(effective.onError || effective.onComplete || effective.onStart || effective.onProgress)
  )
}

/** Internal upkeep is silent, including failures; the run history remains inspectable. */
export const SILENT_MAINTENANCE_NOTIFICATION: TaskNotificationConfig = {
  dueReminder: false,
  onStart: false,
  onProgress: false,
  onComplete: false,
  onError: false,
  channels: ["none"],
}

/** Narrower than system tags: a bot's scheduled deliverable is not internal upkeep. */
export function isSilentMaintenanceType(type: string): boolean {
  return MAINTENANCE_TASK_TYPES.includes(type) || type.startsWith(MAINTENANCE_TASK_TYPE_PREFIX)
}

/** Migrate inherited defaults, preserving deliberately configured notification channels. */
export function maintenanceNotificationPatch(
  notification: TaskNotificationConfig
): Partial<TaskNotificationConfig> | undefined {
  if (notification.dueReminder !== undefined) return undefined
  const channels = notification.channels
  const inherited =
    channels === undefined ||
    (channels.length === 1 &&
      channels[0] === "toast" &&
      notification.onComplete === true &&
      !notification.onStart &&
      !notification.onProgress &&
      notification.onError === true)
  if (inherited) return { ...SILENT_MAINTENANCE_NOTIFICATION }
  return { dueReminder: false }
}

/** True for the app's own recurring maintenance tasks (see module docs). */
export function isMaintenanceTask(
  task: Pick<ScheduledTask, "type" | "tags"> | null | undefined
): boolean {
  if (!task) return false
  if (MAINTENANCE_TASK_TYPES.includes(task.type)) return true
  if (task.type.startsWith(MAINTENANCE_TASK_TYPE_PREFIX)) return true
  return (task.tags ?? []).some((tag) => tag.startsWith(SYSTEM_TASK_TAG_PREFIX))
}
