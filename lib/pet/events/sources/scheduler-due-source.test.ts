import { createSchedulerDueSource, type TaskDueSubscriber } from "./scheduler-due-source"
import type { PetEvent } from "@/types/pet"
import type { DaemonTaskDueEvent } from "@/types/scheduler"

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
    const dispose = createSchedulerDueSource({ subscribe })((e) => events.push({ ...e, at: 0 }))
    await flush()

    push({ taskId: "t1", firedAtMs: 111 })
    push({ taskId: "t2", firedAtMs: 222 })

    expect(events).toEqual([
      { source: "scheduler", kind: "scheduledRunDue", meta: { taskId: "t1" }, at: 0 },
      { source: "scheduler", kind: "scheduledRunDue", meta: { taskId: "t2" }, at: 0 },
    ])

    dispose()
    expect(unlisten).toHaveBeenCalledTimes(1)
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
