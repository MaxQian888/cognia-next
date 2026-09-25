"use client"

/**
 * One scheduled task, kept live.
 *
 * For surfaces outside the scheduler page that name a task by id: the chat's
 * scheduler tool card and the approval dialog for a schedule write. Both are
 * about the schedule on THIS machine, because the `schedule.*` skills write
 * through the local `getTaskScheduler()`, so this reads the local account
 * database rather than the host the scheduler page happens to be managing.
 *
 * `undefined` while the first read is in flight, `null` when no task has that
 * id (deleted, or never existed), the task otherwise. A run, a pause or a
 * rename re-renders the caller without it polling.
 */

import { useLiveQuery } from "dexie-react-hooks"

import { schedulerDb } from "@/lib/scheduler/scheduler-db"
import type { ScheduledTask } from "@/types/scheduler"

export function useLiveScheduledTask(
  taskId: string | null | undefined
): ScheduledTask | null | undefined {
  return useLiveQuery(
    async () => (taskId ? await schedulerDb.getTask(taskId) : null),
    [taskId],
    undefined
  )
}
