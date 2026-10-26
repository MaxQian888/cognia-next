// Native "task is due" signal → pet event. The Rust alarm daemon emits a
// `scheduler:task-due` Tauri event the instant an armed task's fire time
// elapses (see `lib/scheduler/daemon-bridge.ts:listenTaskDue` +
// `src-tauri/src/scheduler/daemon.rs`). Unlike the execution-update broadcast
// (`scheduler-source.ts`, terminal statuses), this is the *forward-looking*
// reminder cue — it fires before/at the run, so the pet can remind the user.
//
// The subscribe transport is async (it awaits the Tauri `listen`), but the pet
// source contract is a synchronous disposer, so we kick the async subscribe off
// and hand back a disposer that tears down whenever the listener resolves. The
// subscribe is injectable so the wiring is unit-tested with a plain fake; the
// default awaits `listenTaskDue` (a no-op off Tauri).

import type { DaemonTaskDueEvent, ScheduledTask } from "@/types/scheduler"
import { isMaintenanceTask } from "@/lib/scheduler/maintenance-tasks"
import { listenTaskDue } from "@/lib/scheduler/daemon-bridge"
import type { PetEmit } from "../pet-event-bus"

export type TaskDueSubscriber = (
  handler: (event: DaemonTaskDueEvent) => void
) => Promise<() => void>

const defaultSubscribe: TaskDueSubscriber = (handler) => listenTaskDue(handler)

export function createSchedulerDueSource(
  deps: {
    subscribe?: TaskDueSubscriber
    getTask?: (id: string) => Promise<ScheduledTask | null>
  } = {}
): (emit: PetEmit) => () => void {
  const subscribe = deps.subscribe ?? defaultSubscribe
  return (emit) => {
    let stop: (() => void) | null = null
    let disposed = false
    void subscribe((event) => {
      void (async () => {
        const task = deps.getTask
          ? await deps.getTask(event.taskId)
          : await (await import("@/lib/scheduler/scheduler-db")).schedulerDb.getTask(event.taskId)
        if (disposed || !task) return
        if (task.notification.dueReminder === false) return
        if (task.notification.dueReminder !== true && isMaintenanceTask(task)) return
        emit({ source: "scheduler", kind: "scheduledRunDue", meta: { taskId: event.taskId } })
      })().catch(() => undefined)
    })
      .then((off) => {
        // Dispose may land before the async subscribe resolves — tear down
        // immediately in that case so we never leak a live listener.
        if (disposed) off()
        else stop = off
      })
      .catch(() => {})
    return () => {
      disposed = true
      if (stop) {
        stop()
        stop = null
      }
    }
  }
}

/** Default wire used by `DEFAULT_PET_SOURCES`. */
export const wireSchedulerDueSource = createSchedulerDueSource()
