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
 * - every connector-owned `connection:housekeeping:*` type
 * - `connection:presence:refresh`
 * - any task tagged `system:<owner>` (housekeeping, provider diagnostics, bot
 *   timed triggers carry such a tag)
 *
 * User-configured connector schedules (`connection:scheduled:digest`,
 * `connection:outbound:send`) are deliberately NOT maintenance: they send
 * something the user asked for, so their outcomes stay user-visible.
 */

import type { ScheduledTask } from "@/types/scheduler"

export const MAINTENANCE_TASK_TYPES: readonly string[] = Object.freeze([
  "provider-diagnostics-refresh",
  "connection:presence:refresh",
])

export const MAINTENANCE_TASK_TYPE_PREFIX = "connection:housekeeping:"
export const SYSTEM_TASK_TAG_PREFIX = "system:"

/** True for the app's own recurring maintenance tasks (see module docs). */
export function isMaintenanceTask(
  task: Pick<ScheduledTask, "type" | "tags"> | null | undefined
): boolean {
  if (!task) return false
  if (MAINTENANCE_TASK_TYPES.includes(task.type)) return true
  if (task.type.startsWith(MAINTENANCE_TASK_TYPE_PREFIX)) return true
  return (task.tags ?? []).some((tag) => tag.startsWith(SYSTEM_TASK_TAG_PREFIX))
}
