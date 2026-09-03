import { createAppSource, createPluginTaskSource, toUnified } from "./app-source"
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
    expect(unified.origin.tableName).toBe("scheduledTasks")
    expect(unified.origin.deepLinkHref).toBe("/scheduler?taskId=task-1")
    // Provenance rides through, so the panel can tell a schedule the user made
    // from one an agent made on their behalf. Undefined for a row that predates
    // the creator column rather than defaulting to "user", which would claim
    // authorship the row does not actually record.
    expect(unified.createdBySource).toBeUndefined()
    expect(unified.capabilities).toEqual({
      runNow: true,
      pause: true,
      edit: true,
      delete: true,
    })
  })

  it("carries the creator kind through so the panel can show who authored it", () => {
    const unified = toUnified(makeTask({ createdBy: { kind: "agent", sessionId: "sess-1" } }))
    expect(unified.createdBySource).toBe("agent")
  })

  it("maps real plugin executor tasks to the plugin kind", () => {
    const unified = toUnified(
      makeTask({
        id: "plugin-row",
        type: "plugin",
        payload: { pluginId: "demo", handler: "heartbeat" },
      })
    )

    expect(unified.kind).toBe("plugin")
    expect(unified.unifiedId).toBe("plugin:plugin-row")
    expect(unified.origin.tableName).toBe("scheduledTasks")
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

  it("splits real plugin tasks into the plugin source without duplication", async () => {
    const tasks = [makeTask({ id: "app-row" }), makeTask({ id: "plugin-row", type: "plugin" })]
    const db = {
      getAllTasks: jest.fn(async () => tasks),
      getTask: jest.fn(async (id: string) => tasks.find((task) => task.id === id) ?? null),
    }
    const scheduler = makeStubs().scheduler

    expect((await createAppSource({ scheduler, db }).list()).map((item) => item.sourceId)).toEqual([
      "app-row",
    ])
    expect(
      (await createPluginTaskSource({ scheduler, db }).list()).map((item) => item.sourceId)
    ).toEqual(["plugin-row"])
  })

  it("filters execution ownership before applying the recent-run limit", async () => {
    const getRecentExecutionsMatching = jest.fn(async (ownsTaskType, limit) => {
      expect(ownsTaskType("chat")).toBe(true)
      expect(ownsTaskType("plugin")).toBe(false)
      expect(limit).toBe(7)
      return []
    })
    const source = createAppSource({
      scheduler: makeStubs().scheduler,
      db: {
        getAllTasks: jest.fn(async () => []),
        getTask: jest.fn(async () => null),
        getRecentExecutionsMatching,
      },
    })

    await expect(source.listRuns?.(7)).resolves.toEqual([])
    expect(getRecentExecutionsMatching).toHaveBeenCalledTimes(1)
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

// ---------------------------------------------------------------------------
// Host target (ADR-0128 §6). The page's host bar promises it switches which
// schedule the page reads AND writes; before this the unified sources always
// read the local Dexie while the store already followed the target.
// ---------------------------------------------------------------------------

describe("app source · managed host target", () => {
  function makeRemote(tasks: ScheduledTask[]) {
    return {
      host: "remote" as const,
      listTasks: jest.fn(async () => tasks),
      getTask: jest.fn(async (id: string) => tasks.find((t) => t.id === id) ?? null),
      getRecentExecutions: jest.fn(async () => []),
      createTask: jest.fn(async () => tasks[0]),
      updateTask: jest.fn(async () => tasks[0]),
      deleteTask: jest.fn(async () => true),
      pauseTask: jest.fn(async () => true),
      resumeTask: jest.fn(async () => true),
      runTaskNow: jest.fn(async () => null),
    }
  }

  function makeLocalStubs() {
    const db = {
      getAllTasks: jest.fn(async () => [makeTask({ id: "local-only" })]),
      getTask: jest.fn(async () => null),
    }
    const scheduler = {
      createTask: jest.fn(),
      updateTask: jest.fn(),
      deleteTask: jest.fn(),
      pauseTask: jest.fn(),
      resumeTask: jest.fn(),
      runTaskNow: jest.fn(),
    }
    return { db, scheduler }
  }

  it("reads the paired host's tasks, not this device's, while the target is remote", async () => {
    const { db, scheduler } = makeLocalStubs()
    const remote = makeRemote([makeTask({ id: "remote-row" })])
    const source = createAppSource({
      scheduler,
      db,
      dataSource: () => remote as never,
    })

    expect((await source.list()).map((item) => item.sourceId)).toEqual(["remote-row"])
    expect((await source.get("remote-row"))?.sourceId).toBe("remote-row")
    expect(db.getAllTasks).not.toHaveBeenCalled()
    expect(db.getTask).not.toHaveBeenCalled()
  })

  it("routes every write to the paired host and leaves the local scheduler untouched", async () => {
    const { db, scheduler } = makeLocalStubs()
    const remote = makeRemote([makeTask({ id: "remote-row" })])
    const source = createAppSource({ scheduler, db, dataSource: () => remote as never })

    await source.create({
      name: "n",
      type: "chat",
      trigger: { type: "cron", cronExpression: "* * * * *" },
    })
    await source.update("remote-row", { description: "x" })
    await source.pause("remote-row")
    await source.resume("remote-row")
    await source.runNow("remote-row")
    await source.delete("remote-row")

    expect(remote.createTask).toHaveBeenCalledTimes(1)
    expect(remote.updateTask).toHaveBeenCalledWith("remote-row", { description: "x" })
    expect(remote.pauseTask).toHaveBeenCalledWith("remote-row")
    expect(remote.resumeTask).toHaveBeenCalledWith("remote-row")
    expect(remote.runTaskNow).toHaveBeenCalledWith("remote-row", { triggerSource: "run-now" })
    expect(remote.deleteTask).toHaveBeenCalledWith("remote-row")
    for (const fn of Object.values(scheduler)) expect(fn).not.toHaveBeenCalled()
  })

  it("over-fetches remote runs and keeps only this kind's, capped at the limit", async () => {
    const { db, scheduler } = makeLocalStubs()
    const remote = makeRemote([])
    remote.getRecentExecutions = jest.fn(
      async () =>
        [
          { id: "r1", taskId: "a", taskName: "a", taskType: "chat", status: "completed" },
          { id: "r2", taskId: "p", taskName: "p", taskType: "plugin", status: "completed" },
          { id: "r3", taskId: "b", taskName: "b", taskType: "chat", status: "completed" },
        ].map((row) => ({ ...row, retryAttempt: 0, startedAt: new Date(0), logs: [] })) as never
    )
    const source = createAppSource({ scheduler, db, dataSource: () => remote as never })

    const runs = await source.listRuns!(2)
    // 2 * 4 = 8 requested, so a busy sibling kind cannot starve this one.
    expect(remote.getRecentExecutions).toHaveBeenCalledWith(8)
    expect(runs.map((run) => run.unifiedId)).toEqual(["app:r1", "app:r3"])
  })

  it("polls the paired host and re-reads immediately after its own writes", async () => {
    jest.useFakeTimers()
    try {
      const { db, scheduler } = makeLocalStubs()
      const remote = makeRemote([makeTask({ id: "remote-row" })])
      const source = createAppSource({
        scheduler,
        db,
        dataSource: () => remote as never,
        remotePollIntervalMs: 1_000,
      })

      const emitted: number[] = []
      const sub = source.subscribe({ next: (items) => emitted.push(items.length) })
      await Promise.resolve()
      expect(remote.listTasks).toHaveBeenCalledTimes(1)

      jest.advanceTimersByTime(2_000)
      expect(remote.listTasks).toHaveBeenCalledTimes(3)

      await source.pause("remote-row")
      expect(remote.listTasks).toHaveBeenCalledTimes(4)

      sub.unsubscribe()
      jest.advanceTimersByTime(5_000)
      expect(remote.listTasks).toHaveBeenCalledTimes(4)
      expect(emitted.length).toBeGreaterThan(0)
    } finally {
      jest.useRealTimers()
    }
  })

  it("re-attaches the subscription when the managed host flips", async () => {
    const { db, scheduler } = makeLocalStubs()
    const remote = makeRemote([makeTask({ id: "remote-row" })])
    let host: "local" | "remote" = "local"
    let notify: (() => void) | null = null

    const observe = jest.fn((querier: () => Promise<ScheduledTask[]>) => ({
      subscribe(obs: { next: (t: ScheduledTask[]) => void }) {
        void querier().then(obs.next)
        return { unsubscribe: jest.fn() }
      },
    }))

    const source = createAppSource({
      scheduler,
      db,
      observe,
      remotePollIntervalMs: 60_000,
      dataSource: () => (host === "remote" ? (remote as never) : ({ host: "local" } as never)),
      onHostTargetChange: (listener) => {
        notify = listener
        return () => {
          notify = null
        }
      },
    })

    const seen: string[][] = []
    const sub = source.subscribe({ next: (items) => seen.push(items.map((i) => i.sourceId)) })
    await Promise.resolve()
    await Promise.resolve()
    expect(seen.at(-1)).toEqual(["local-only"])

    host = "remote"
    notify!()
    await Promise.resolve()
    await Promise.resolve()
    expect(seen.at(-1)).toEqual(["remote-row"])

    sub.unsubscribe()
  })
})
