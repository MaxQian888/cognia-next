// Renderer background-task lifecycle → pet events. This consumes the dedicated
// low-frequency start/settle seam instead of the hot subagent runtime store,
// which also updates on every token and tool event.

import {
  listRendererBackgroundRuns,
  subscribeRendererBackgroundLifecycle,
  type RendererBackgroundLifecycleEvent,
} from "@/lib/background-tasks/renderer-subagent-registry"
import type { BackgroundTaskKind } from "@/lib/background-tasks/registry-core"
import type { PetEmit } from "../pet-event-bus"

export type BackgroundTaskLifecycleEvent = RendererBackgroundLifecycleEvent

export interface ActiveBackgroundTask {
  runId: string
  taskKind: BackgroundTaskKind
}

export interface BackgroundTaskSourceDeps {
  subscribe?: (listener: (event: BackgroundTaskLifecycleEvent) => void) => () => void
  getActive?: () => readonly ActiveBackgroundTask[]
}

function defaultActive(): ActiveBackgroundTask[] {
  return listRendererBackgroundRuns()
    .filter((task) => task.status === "running")
    .map((task) => ({ runId: task.runId, taskKind: task.kind }))
}

export function createBackgroundTaskSource(
  deps: BackgroundTaskSourceDeps = {}
): (emit: PetEmit) => () => void {
  const subscribe = deps.subscribe ?? subscribeRendererBackgroundLifecycle
  const getActive = deps.getActive ?? defaultActive

  return (emit) => {
    const initial = getActive()
    const active = new Map(initial.map((task) => [task.runId, task.taskKind]))
    let batchFailed = false

    if (initial.length > 0) {
      const latest = initial.at(-1)!
      emit({
        source: "background-task",
        kind: "thinking",
        xp: 0,
        meta: {
          activeCount: active.size,
          runId: latest.runId,
          taskKind: latest.taskKind,
        },
      })
    }

    return subscribe((event) => {
      if (event.type === "started") {
        if (active.has(event.runId)) return
        const wasIdle = active.size === 0
        if (wasIdle) batchFailed = false
        active.set(event.runId, event.taskKind)
        if (wasIdle) {
          emit({
            source: "background-task",
            kind: "thinking",
            xp: 0,
            meta: {
              activeCount: active.size,
              runId: event.runId,
              taskKind: event.taskKind,
            },
          })
        }
        return
      }

      if (!active.delete(event.runId)) return
      if (event.status === "error") batchFailed = true
      if (active.size > 0) return

      emit({
        source: "background-task",
        kind: batchFailed ? "error" : "success",
        xp: batchFailed ? 0 : 3,
        meta: {
          activeCount: 0,
          runId: event.runId,
          status: batchFailed ? "error" : "done",
        },
      })
      batchFailed = false
    })
  }
}

export const wireBackgroundTaskSource = createBackgroundTaskSource()
