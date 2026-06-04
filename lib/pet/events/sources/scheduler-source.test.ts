import {
  schedulerMessageToPetEvent,
  createSchedulerSource,
  type MessageSubscriber,
} from "./scheduler-source"
import type { PetEvent } from "@/types/pet"

describe("schedulerMessageToPetEvent", () => {
  const base = { type: "execution-update", executionId: "e1", taskName: "T" }

  it("maps a completed execution to scheduledRun", () => {
    expect(schedulerMessageToPetEvent({ ...base, taskId: "t1", status: "completed" })).toEqual({
      source: "scheduler",
      kind: "scheduledRun",
      meta: { taskId: "t1" },
    })
  })

  it("maps a failed execution to the generic error kind", () => {
    expect(schedulerMessageToPetEvent({ ...base, taskId: "t1", status: "failed" })).toEqual({
      source: "scheduler",
      kind: "error",
      meta: { taskId: "t1" },
    })
  })

  it("ignores in-progress and other terminal statuses", () => {
    for (const status of ["pending", "running", "cancelled", "skipped"]) {
      expect(schedulerMessageToPetEvent({ ...base, taskId: "t1", status })).toBeNull()
    }
  })

  it("ignores non-execution-update message types", () => {
    expect(
      schedulerMessageToPetEvent({ type: "other", taskId: "t1", status: "completed" })
    ).toBeNull()
  })

  it("ignores messages without a string taskId", () => {
    expect(schedulerMessageToPetEvent({ ...base, status: "completed" })).toBeNull()
    expect(schedulerMessageToPetEvent({ ...base, taskId: 5, status: "completed" })).toBeNull()
  })

  it("ignores non-object / nullish payloads", () => {
    expect(schedulerMessageToPetEvent(null)).toBeNull()
    expect(schedulerMessageToPetEvent("nope")).toBeNull()
    expect(schedulerMessageToPetEvent(undefined)).toBeNull()
  })
})

describe("createSchedulerSource", () => {
  it("emits only for mapped messages and tears down via the subscriber", () => {
    let push: (msg: unknown) => void = () => {}
    const unsubscribe = jest.fn()
    const subscribe: MessageSubscriber = (handler) => {
      push = handler
      return unsubscribe
    }
    const events: PetEvent[] = []
    const wire = createSchedulerSource({ subscribe })
    const dispose = wire((e) => events.push({ ...e, at: 0 }))

    push({ type: "execution-update", taskId: "t1", status: "running" }) // ignored
    push({ type: "execution-update", taskId: "t1", status: "completed" }) // → scheduledRun
    push({ type: "execution-update", taskId: "t2", status: "failed" }) // → error
    push("garbage") // ignored

    expect(events.map((e) => e.kind)).toEqual(["scheduledRun", "error"])
    expect(events[0]).toMatchObject({ source: "scheduler", meta: { taskId: "t1" } })

    dispose()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it("subscribes to a BroadcastChannel by default and closes it on dispose", () => {
    // The node test env has no BroadcastChannel; inject a fake to exercise the
    // default subscribe path (addEventListener / dispatch / close).
    const listeners = new Set<(e: { data: unknown }) => void>()
    const close = jest.fn()
    let openName: string | undefined
    class FakeChannel {
      constructor(name: string) {
        openName = name
      }
      addEventListener(_type: string, fn: (e: { data: unknown }) => void) {
        listeners.add(fn)
      }
      removeEventListener(_type: string, fn: (e: { data: unknown }) => void) {
        listeners.delete(fn)
      }
      close = close
    }
    const original = globalThis.BroadcastChannel
    globalThis.BroadcastChannel = FakeChannel as unknown as typeof BroadcastChannel
    try {
      const events: PetEvent[] = []
      const dispose = createSchedulerSource()((e) => events.push({ ...e, at: 0 }))
      expect(openName).toBe("cognia-scheduler-executions")

      for (const fn of listeners)
        fn({ data: { type: "execution-update", taskId: "t9", status: "completed" } })
      expect(events.map((e) => e.kind)).toEqual(["scheduledRun"])

      dispose()
      expect(close).toHaveBeenCalledTimes(1)
      expect(listeners.size).toBe(0)
    } finally {
      globalThis.BroadcastChannel = original
    }
  })

  it("falls back to a no-op when BroadcastChannel is unavailable", () => {
    const original = globalThis.BroadcastChannel
    // @ts-expect-error -- intentionally removing the global for the guard path.
    delete globalThis.BroadcastChannel
    try {
      const dispose = createSchedulerSource()(jest.fn())
      expect(() => dispose()).not.toThrow()
    } finally {
      globalThis.BroadcastChannel = original
    }
  })
})
