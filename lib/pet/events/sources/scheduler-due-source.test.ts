import { createSchedulerDueSource, type TaskDueSubscriber } from "./scheduler-due-source"
import type { PetEvent } from "@/types/pet"
import type { DaemonTaskDueEvent, ScheduledTask } from "@/types/scheduler"

const flush = () => Promise.resolve().then(() => Promise.resolve())

describe("createSchedulerDueSource", () => {
  it("emits scheduledRunDue for each native task-due event", async () => {
    let push: (e: DaemonTaskDueEvent) => void = () => {}
    const unlisten = jest.fn()
    const subscribe: TaskDueSubscriber = async (handler) => {
      push = handler
      return unlisten
    }
    const events: PetEvent[] = []
    const dispose = createSchedulerDueSource({
      subscribe,
      getTask: async (id) => ({ id, type: "chat", notification: {} }) as ScheduledTask,
    })((e) => events.push({ ...e, at: 0 }))
    await flush()

    push({ taskId: "t1", firedAtMs: 111, scheduledForMs: 110 })
    push({ taskId: "t2", firedAtMs: 222, scheduledForMs: 220 })
    await flush()

    expect(events).toEqual([
      { source: "scheduler", kind: "scheduledRunDue", meta: { taskId: "t1" }, at: 0 },
      { source: "scheduler", kind: "scheduledRunDue", meta: { taskId: "t2" }, at: 0 },
    ])

    dispose()
    expect(unlisten).toHaveBeenCalledTimes(1)
  })

  it("filters maintenance and muted due signals before they reach pet speech or reminders", async () => {
    let push: (e: DaemonTaskDueEvent) => void = () => {}
    const emit = jest.fn()
    const dispose = createSchedulerDueSource({
      subscribe: async (handler) => {
        push = handler
        return () => undefined
      },
      getTask: async (id) =>
        ({
          id,
          type: id === "maintenance" ? "github-issue-sync" : "chat",
          notification: id === "muted" ? { dueReminder: false } : {},
        }) as ScheduledTask,
    })(emit)
    await flush()
    push({ taskId: "maintenance", firedAtMs: 1, scheduledForMs: 1 })
    push({ taskId: "muted", firedAtMs: 1, scheduledForMs: 1 })
    await flush()
    expect(emit).not.toHaveBeenCalled()
    dispose()
  })

  it("tears down a listener that resolves AFTER dispose (no leak)", async () => {
    const unlisten = jest.fn()
    let resolveSub: (off: () => void) => void = () => {}
    const subscribe: TaskDueSubscriber = () =>
      new Promise<() => void>((res) => {
        resolveSub = res
      })
    const dispose = createSchedulerDueSource({ subscribe })(jest.fn())

    dispose() // dispose before the async subscribe resolves
    resolveSub(unlisten)
    await flush()

    expect(unlisten).toHaveBeenCalledTimes(1)
  })

  it("default wire no-ops off Tauri and disposes cleanly", async () => {
    const dispose = createSchedulerDueSource()(jest.fn())
    await flush()
    expect(() => dispose()).not.toThrow()
  })
})

it("honors an explicit reminder opt-in for internal maintenance", async () => {
  let push: (e: DaemonTaskDueEvent) => void = () => {}
  const emit = jest.fn()
  const dispose = createSchedulerDueSource({
    subscribe: async (handler) => {
      push = handler
      return () => undefined
    },
    getTask: async (id) =>
      ({ id, type: "github-issue-sync", notification: { dueReminder: true } }) as ScheduledTask,
  })(emit)
  await flush()
  push({ taskId: "opt-in", firedAtMs: 1, scheduledForMs: 1 })
  await flush()
  expect(emit).toHaveBeenCalledWith(expect.objectContaining({ kind: "scheduledRunDue" }))
  dispose()
})
