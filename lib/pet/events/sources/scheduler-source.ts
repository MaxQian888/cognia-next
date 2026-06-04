// Scheduler executions → pet events. The task scheduler broadcasts
// `execution-update` messages on `BroadcastChannel("cognia-scheduler-executions")`
// (see `lib/scheduler/task-scheduler.ts`). A completed run nudges the pet with
// `scheduledRun`; a failed run maps to the generic `error` radar kind (same one
// the workflow source uses). All other statuses and malformed messages are
// ignored.
//
// The subscribe transport is injectable so the pure mapping is unit-tested with
// a plain fake; the default opens the BroadcastChannel.

import type { PetEvent } from "@/types/pet"
import type { PetEmit } from "../pet-event-bus"

const CHANNEL_NAME = "cognia-scheduler-executions"

/** The argument shape `PetEmit` accepts (the bus stamps `at`). */
export type PetEventInput = Omit<PetEvent, "at"> & { at?: number }

/**
 * Pure mapping from a raw scheduler broadcast message to a pet emit (or null
 * when the message is irrelevant or malformed). Completed → `scheduledRun`,
 * failed → `error`; everything else is ignored.
 */
export function schedulerMessageToPetEvent(msg: unknown): PetEventInput | null {
  if (!msg || typeof msg !== "object") return null
  const m = msg as Record<string, unknown>
  if (m.type !== "execution-update") return null
  if (typeof m.taskId !== "string") return null
  const taskId = m.taskId
  if (m.status === "completed")
    return { source: "scheduler", kind: "scheduledRun", meta: { taskId } }
  if (m.status === "failed") return { source: "scheduler", kind: "error", meta: { taskId } }
  return null
}

export type MessageSubscriber = (handler: (msg: unknown) => void) => () => void

const defaultSubscribe: MessageSubscriber = (handler) => {
  if (typeof BroadcastChannel === "undefined") return () => {}
  const channel = new BroadcastChannel(CHANNEL_NAME)
  const listener = (e: MessageEvent) => handler(e.data)
  channel.addEventListener("message", listener)
  return () => {
    channel.removeEventListener("message", listener)
    channel.close()
  }
}

export function createSchedulerSource(
  deps: { subscribe?: MessageSubscriber } = {}
): (emit: PetEmit) => () => void {
  const subscribe = deps.subscribe ?? defaultSubscribe
  return (emit) =>
    subscribe((msg) => {
      const mapped = schedulerMessageToPetEvent(msg)
      if (mapped) emit(mapped)
    })
}

/** Default wire used by `DEFAULT_PET_SOURCES`. */
export const wireSchedulerSource = createSchedulerSource()
