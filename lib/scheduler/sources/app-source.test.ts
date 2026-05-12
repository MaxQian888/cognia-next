import { createAppSource, toUnified } from "./app-source"
import type { ScheduledTask } from "@/types/scheduler"

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task-1",
    name: "My Task",
    description: "desc",
    type: "chat",
    trigger: {
      type: "cron",
      cronExpression: "0 9 * * *",
      timezone: "UTC",
    },
    payload: { prompt: "hi" },
    config: {
      timeout: 300_000,
      maxRetries: 3,
      retryDelay: 5_000,
      runMissedOnStartup: false,
      allowConcurrent: false,
    },
    notification: {
      onStart: false,
      onComplete: true,
      onError: true,
      channels: ["toast"],
    },
    status: "active",
    runCount: 5,
    successCount: 4,
    failureCount: 1,
    nextRunAt: new Date("2026-05-12T09:00:00Z"),
    lastRunAt: new Date("2026-05-11T09:00:00Z"),
    createdAt: new Date("2026-04-01T00:00:00Z"),
    updatedAt: new Date("2026-04-01T00:00:00Z"),
    ...overrides,
  } as ScheduledTask
}

describe("toUnified (app source mapper)", () => {
  it("maps a cron task to the unified shape", () => {
    const task = makeTask()
    const unified = toUnified(task)
    expect(unified.unifiedId).toBe("app:task-1")
    expect(unified.kind).toBe("app")
    expect(unified.sourceId).toBe("task-1")
    expect(unified.name).toBe("My Task")
    expect(unified.status).toBe("active")
    expect(unified.triggerSummary).toEqual({
      type: "cron",
      cron: "0 9 * * *",
      intervalMs: undefined,
      runAtMs: undefined,
      eventType: undefined,
      timezone: "UTC",
    })
    expect(unified.nextRunAt).toBe(new Date("2026-05-12T09:00:00Z").getTime())
    expect(unified.successCount).toBe(4)
    expect(unified.failureCount).toBe(1)
    expect(unified.origin.tableName).toBe("tasks")
    expect(unified.origin.deepLinkHref).toBe("/scheduler?taskId=task-1")
    expect(unified.capabilities).toEqual({
      runNow: true,
      pause: true,
      edit: true,
      delete: true,
    })
  })

  it("collapses an unknown status to 'unknown'", () => {
    const task = makeTask({ status: "weird" as never })
    expect(toUnified(task).status).toBe("unknown")
  })

  it("preserves interval / once / event trigger summaries", () => {
    expect(
      toUnified(
        makeTask({
          trigger: { type: "interval", intervalMs: 60_000 },
        })
      ).triggerSummary
    ).toEqual({
      type: "interval",
      cron: undefined,
      intervalMs: 60_000,
      runAtMs: undefined,
      eventType: undefined,
      timezone: undefined,
    })

    const runAt = new Date("2026-06-01T08:00:00Z")
    expect(toUnified(makeTask({ trigger: { type: "once", runAt } })).triggerSummary.runAtMs).toBe(
      runAt.getTime()
    )

    expect(
      toUnified(makeTask({ trigger: { type: "event", eventType: "test.done" } })).triggerSummary
        .eventType
    ).toBe("test.done")
  })
})

describe("createAppSource", () => {
  function makeStubs() {
    const tasks: ScheduledTask[] = [makeTask({ id: "a" }), makeTask({ id: "b", name: "B" })]
    const db = {
      getAllTasks: jest.fn(async () => tasks),
      getTask: jest.fn(async (id: string) => tasks.find((t) => t.id === id) ?? null),
    }
    const scheduler = {
      createTask: jest.fn(async () => tasks[0]),
      updateTask: jest.fn(async () => tasks[0]),
      deleteTask: jest.fn(async () => true),
      pauseTask: jest.fn(async () => true),
      resumeTask: jest.fn(async () => true),
      runTaskNow: jest.fn(async () => ({})),
    }
    return { tasks, db, scheduler }
  }

  it("list() returns mapped unified items", async () => {
    const { db, scheduler } = makeStubs()
    const source = createAppSource({ scheduler, db })
    const items = await source.list()
    expect(items).toHaveLength(2)
    expect(items[0].unifiedId).toBe("app:a")
    expect(items[1].unifiedId).toBe("app:b")
  })

  it("excludes connector-owned tasks (type prefixed with 'connection:') from the app kind", async () => {
    const tasks: ScheduledTask[] = [
      makeTask({ id: "app-row" }),
      makeTask({ id: "digest-row", type: "connection:scheduled:digest" }),
      makeTask({ id: "send-row", type: "connection:outbound:send" }),
    ]
    const db = {
      getAllTasks: jest.fn(async () => tasks),
      getTask: jest.fn(async (id: string) => tasks.find((t) => t.id === id) ?? null),
    }
    const scheduler = {
      createTask: jest.fn(),
      updateTask: jest.fn(),
      deleteTask: jest.fn(),
      pauseTask: jest.fn(),
      resumeTask: jest.fn(),
      runTaskNow: jest.fn(),
    }
    const source = createAppSource({ scheduler, db })
    const items = await source.list()
    expect(items.map((i) => i.sourceId)).toEqual(["app-row"])
    expect(await source.get("digest-row")).toBeUndefined()
    expect(await source.get("send-row")).toBeUndefined()
    expect((await source.get("app-row"))?.sourceId).toBe("app-row")
  })

  it("get() returns undefined for a missing id", async () => {
    const { db, scheduler } = makeStubs()
    const source = createAppSource({ scheduler, db })
    const item = await source.get("missing")
    expect(item).toBeUndefined()
    expect(db.getTask).toHaveBeenCalledWith("missing")
  })

  it("dispatches CRUD to the underlying scheduler", async () => {
    const { db, scheduler } = makeStubs()
    const source = createAppSource({ scheduler, db })

    await source.create({
      name: "n",
      type: "chat",
      trigger: { type: "cron", cronExpression: "* * * * *" },
    })
    expect(scheduler.createTask).toHaveBeenCalledTimes(1)

    await source.update("a", { description: "updated" })
    expect(scheduler.updateTask).toHaveBeenCalledWith("a", { description: "updated" })

    await source.delete("a")
    expect(scheduler.deleteTask).toHaveBeenCalledWith("a")

    await source.pause("a")
    expect(scheduler.pauseTask).toHaveBeenCalledWith("a")

    await source.resume("a")
    expect(scheduler.resumeTask).toHaveBeenCalledWith("a")

    await source.runNow("a")
    expect(scheduler.runTaskNow).toHaveBeenCalledWith("a")
  })

  it("subscribe() pushes unified items through the observer", () => {
    const { tasks, db, scheduler } = makeStubs()
    const observerCalls: unknown[][] = []
    const observe = jest.fn(() => ({
      subscribe(obs: { next: (t: ScheduledTask[]) => void }) {
        obs.next(tasks)
        return { unsubscribe: jest.fn() }
      },
    }))

    const source = createAppSource({ scheduler, db, observe })
    const sub = source.subscribe({
      next: (items) => observerCalls.push(items),
    })
    expect(observerCalls).toHaveLength(1)
    expect(observerCalls[0]).toHaveLength(2)
    expect((observerCalls[0] as Array<{ unifiedId: string }>)[0].unifiedId).toBe("app:a")
    sub.unsubscribe()
  })
})
