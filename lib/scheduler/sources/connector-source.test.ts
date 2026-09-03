import {
  CONNECTOR_DIGEST_TYPE,
  CONNECTOR_QUEUE_SOURCE_ID,
  CONNECTOR_TASK_TYPE_PREFIX,
  createConnectorSource,
  toUnifiedConnectorDigest,
  toUnifiedOutboundQueue,
} from "./connector-source"
import type { ScheduledTask } from "@/types/scheduler"

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "conn-1",
    name: "Daily digest",
    description: "Send a daily summary",
    type: CONNECTOR_DIGEST_TYPE,
    trigger: { type: "cron", cronExpression: "0 8 * * *", timezone: "UTC" },
    payload: {
      adapterId: "adapter-1",
      conversationKey: "tg:42",
      characterId: "char-1",
      prompt: "summarize",
    },
    config: {
      timeout: 60_000,
      maxRetries: 3,
      retryDelay: 5_000,
      runMissedOnStartup: false,
      allowConcurrent: false,
    },
    notification: { onStart: false, onComplete: true, onError: true, channels: [] },
    status: "active",
    runCount: 1,
    successCount: 1,
    failureCount: 0,
    nextRunAt: new Date("2026-05-13T08:00:00Z"),
    lastRunAt: new Date("2026-05-12T08:00:00Z"),
    createdAt: new Date("2026-05-01T00:00:00Z"),
    updatedAt: new Date("2026-05-01T00:00:00Z"),
    ...overrides,
  } as ScheduledTask
}

describe("constants", () => {
  it("exposes a stable connector task-type prefix that matches the executor name", () => {
    expect(CONNECTOR_TASK_TYPE_PREFIX).toBe("connection:")
    expect(CONNECTOR_DIGEST_TYPE).toBe("connection:scheduled:digest")
    expect(CONNECTOR_DIGEST_TYPE.startsWith(CONNECTOR_TASK_TYPE_PREFIX)).toBe(true)
  })

  it("exposes a stable rollup sourceId so deep-links can target it", () => {
    expect(CONNECTOR_QUEUE_SOURCE_ID).toBe("outbound:queue")
  })
})

describe("toUnifiedConnectorDigest", () => {
  it("maps a connection:scheduled:digest task to the unified shape under the connector kind", () => {
    const task = makeTask()
    const unified = toUnifiedConnectorDigest(task)
    expect(unified.unifiedId).toBe("connector:conn-1")
    expect(unified.kind).toBe("connector")
    expect(unified.sourceId).toBe("conn-1")
    expect(unified.status).toBe("active")
    expect(unified.triggerSummary).toMatchObject({
      type: "cron",
      cron: "0 8 * * *",
      timezone: "UTC",
    })
    expect(unified.nextRunAt).toBe(new Date("2026-05-13T08:00:00Z").getTime())
    expect(unified.lastRunAt).toBe(new Date("2026-05-12T08:00:00Z").getTime())
    expect(unified.origin.tableName).toBe("scheduledTasks")
    expect(unified.origin.deepLinkHref).toBe("/scheduler?taskId=conn-1")
    expect(unified.capabilities).toEqual({ runNow: true, pause: true, edit: true, delete: true })
  })

  it("uses task.type as the description fallback when the task has none", () => {
    const unified = toUnifiedConnectorDigest(makeTask({ description: undefined }))
    expect(unified.description).toBe(CONNECTOR_DIGEST_TYPE)
  })

  it("collapses an unknown status to 'unknown'", () => {
    expect(toUnifiedConnectorDigest(makeTask({ status: "weird" as never })).status).toBe("unknown")
  })
})

describe("toUnifiedOutboundQueue", () => {
  it("renders the queue length in the row name", () => {
    expect(toUnifiedOutboundQueue(7).name).toContain("(7)")
  })

  it("uses the connector kind with the synthetic queue sourceId", () => {
    const unified = toUnifiedOutboundQueue(0)
    expect(unified.unifiedId).toBe("connector:outbound:queue")
    expect(unified.sourceId).toBe("outbound:queue")
    expect(unified.kind).toBe("connector")
  })

  it("marks the rollup as read-only (no actions surfaced)", () => {
    expect(toUnifiedOutboundQueue(0).capabilities).toEqual({
      runNow: false,
      pause: false,
      edit: false,
      delete: false,
    })
  })

  it("flags status active when the queue has work and unknown when empty", () => {
    expect(toUnifiedOutboundQueue(3).status).toBe("active")
    expect(toUnifiedOutboundQueue(0).status).toBe("unknown")
  })

  it("deep-links to the connections settings outbound tab", () => {
    expect(toUnifiedOutboundQueue(0).origin.deepLinkHref).toContain("connections")
    expect(toUnifiedOutboundQueue(0).origin.deepLinkHref).toContain("outbound")
  })
})

describe("createConnectorSource — list", () => {
  function stubDb(tasks: ScheduledTask[]) {
    return {
      getAllTasks: jest.fn().mockResolvedValue(tasks),
      getTask: jest.fn(async (id: string) => tasks.find((t) => t.id === id) ?? null),
    }
  }

  function stubProbe(count: number) {
    return { count: jest.fn().mockResolvedValue(count) }
  }

  it("returns digest items + the outbound-queue rollup", async () => {
    const tasks = [
      makeTask({ id: "d-1", type: CONNECTOR_DIGEST_TYPE }),
      makeTask({ id: "d-2", type: CONNECTOR_DIGEST_TYPE }),
    ]
    const source = createConnectorSource({
      db: stubDb(tasks),
      outboundQueueProbe: stubProbe(5),
    })
    const items = await source.list()
    expect(items).toHaveLength(3)
    expect(items.map((i) => i.unifiedId)).toEqual([
      "connector:d-1",
      "connector:d-2",
      "connector:outbound:queue",
    ])
  })

  it("ignores tasks that are not connector-owned", async () => {
    const tasks = [
      makeTask({ id: "d-1", type: CONNECTOR_DIGEST_TYPE }),
      makeTask({ id: "not-connector", type: "chat" }),
    ]
    const source = createConnectorSource({
      db: stubDb(tasks),
      outboundQueueProbe: stubProbe(0),
    })
    const items = await source.list()
    expect(items.map((i) => i.sourceId)).toEqual(["d-1", "outbound:queue"])
  })

  it("falls back to a zero queue length when the probe rejects", async () => {
    const source = createConnectorSource({
      db: stubDb([]),
      outboundQueueProbe: { count: jest.fn().mockRejectedValue(new Error("dexie down")) },
    })
    const items = await source.list()
    expect(items).toHaveLength(1)
    expect(items[0].name).toContain("(0)")
  })

  it("merges connector task executions and audit rows through the run contract", async () => {
    const getRecentExecutionsMatching = jest.fn(async (ownsTaskType, limit) => {
      expect(ownsTaskType(CONNECTOR_DIGEST_TYPE)).toBe(true)
      expect(ownsTaskType("chat")).toBe(false)
      expect(limit).toBe(7)
      return []
    })
    const listAuditRuns = jest.fn(async () => [])
    const source = createConnectorSource({
      db: {
        getAllTasks: jest.fn(async () => []),
        getTask: jest.fn(async () => null),
        getRecentExecutionsMatching,
      },
      outboundQueueProbe: stubProbe(0),
      listAuditRuns,
    })

    await expect(source.listRuns?.(7)).resolves.toEqual([])
    expect(getRecentExecutionsMatching).toHaveBeenCalledTimes(1)
    expect(listAuditRuns).toHaveBeenCalledWith(7)
  })
})

describe("createConnectorSource — get", () => {
  function stubDb(tasks: ScheduledTask[]) {
    return {
      getAllTasks: jest.fn().mockResolvedValue(tasks),
      getTask: jest.fn(async (id: string) => tasks.find((t) => t.id === id) ?? null),
    }
  }

  it("returns the rollup row when asked for the queue sourceId", async () => {
    const source = createConnectorSource({
      db: stubDb([]),
      outboundQueueProbe: { count: jest.fn().mockResolvedValue(2) },
    })
    const item = await source.get(CONNECTOR_QUEUE_SOURCE_ID)
    expect(item?.sourceId).toBe(CONNECTOR_QUEUE_SOURCE_ID)
    expect(item?.name).toContain("(2)")
  })

  it("returns undefined when the sourceId names a non-connector task", async () => {
    const tasks = [makeTask({ id: "not-conn", type: "chat" })]
    const source = createConnectorSource({
      db: stubDb(tasks),
      outboundQueueProbe: { count: jest.fn().mockResolvedValue(0) },
    })
    expect(await source.get("not-conn")).toBeUndefined()
  })

  it("returns undefined when no task matches the sourceId", async () => {
    const source = createConnectorSource({
      db: stubDb([]),
      outboundQueueProbe: { count: jest.fn().mockResolvedValue(0) },
    })
    expect(await source.get("missing")).toBeUndefined()
  })
})

describe("createConnectorSource — mutations", () => {
  function setup(count = 0) {
    const tasks = [makeTask({ id: "d-1", type: CONNECTOR_DIGEST_TYPE })]
    const scheduler = {
      updateTask: jest.fn().mockResolvedValue(tasks[0]),
      deleteTask: jest.fn().mockResolvedValue(true),
      pauseTask: jest.fn().mockResolvedValue(true),
      resumeTask: jest.fn().mockResolvedValue(true),
      runTaskNow: jest.fn().mockResolvedValue(undefined),
    }
    const source = createConnectorSource({
      scheduler,
      db: {
        getAllTasks: jest.fn().mockResolvedValue(tasks),
        getTask: jest.fn(async (id: string) => tasks.find((t) => t.id === id) ?? null),
      },
      outboundQueueProbe: { count: jest.fn().mockResolvedValue(count) },
    })
    return { scheduler, source }
  }

  it("routes pause / resume / runNow / delete / update to the task-scheduler for digest items", async () => {
    const { scheduler, source } = setup()
    await source.pause("d-1")
    await source.resume("d-1")
    await source.runNow("d-1")
    await source.delete("d-1")
    await source.update?.("d-1", { name: "renamed" })
    expect(scheduler.pauseTask).toHaveBeenCalledWith("d-1")
    expect(scheduler.resumeTask).toHaveBeenCalledWith("d-1")
    expect(scheduler.runTaskNow).toHaveBeenCalledWith("d-1")
    expect(scheduler.deleteTask).toHaveBeenCalledWith("d-1")
    expect(scheduler.updateTask).toHaveBeenCalledWith("d-1", { name: "renamed" })
  })

  it("no-ops mutation calls targeting the rollup row", async () => {
    const { scheduler, source } = setup()
    await source.pause(CONNECTOR_QUEUE_SOURCE_ID)
    await source.resume(CONNECTOR_QUEUE_SOURCE_ID)
    await source.runNow(CONNECTOR_QUEUE_SOURCE_ID)
    await source.delete(CONNECTOR_QUEUE_SOURCE_ID)
    await source.update?.(CONNECTOR_QUEUE_SOURCE_ID, { name: "ignored" })
    expect(scheduler.pauseTask).not.toHaveBeenCalled()
    expect(scheduler.resumeTask).not.toHaveBeenCalled()
    expect(scheduler.runTaskNow).not.toHaveBeenCalled()
    expect(scheduler.deleteTask).not.toHaveBeenCalled()
    expect(scheduler.updateTask).not.toHaveBeenCalled()
  })

  it("rejects create() — connector jobs are not authored from the scheduler page", async () => {
    const { source } = setup()
    await expect(source.create?.({} as never)).rejects.toThrow(/not supported/i)
  })
})

describe("createConnectorSource — subscribe", () => {
  it("emits a merged snapshot whenever the task list or the queue count changes", () => {
    const taskObservers: Array<{ next: (rows: ScheduledTask[]) => void }> = []
    const queueObservers: Array<{ next: (n: number) => void }> = []
    const taskObservable = {
      subscribe: (o: { next: (rows: ScheduledTask[]) => void }) => {
        taskObservers.push(o)
        return { unsubscribe: () => {} }
      },
    }
    const queueObservable = {
      subscribe: (o: { next: (n: number) => void }) => {
        queueObservers.push(o)
        return { unsubscribe: () => {} }
      },
    }
    const source = createConnectorSource({
      db: {
        getAllTasks: jest.fn().mockResolvedValue([]),
        getTask: jest.fn().mockResolvedValue(null),
      },
      outboundQueueProbe: { count: jest.fn().mockResolvedValue(0) },
      observe: () => taskObservable as never,
      observeQueueCount: () => queueObservable as never,
    })

    const emissions: number[] = []
    const sub = source.subscribe({ next: (items) => emissions.push(items.length) })

    taskObservers[0].next([makeTask({ id: "d-1", type: CONNECTOR_DIGEST_TYPE })])
    queueObservers[0].next(4)
    // Two emits: 1 digest + queue rollup (after task push, queue still 0) and then again after queue push
    expect(emissions[0]).toBe(2)
    expect(emissions[1]).toBe(2)
    sub.unsubscribe()
  })
})
