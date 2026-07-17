import {
  registerScheduledTasksForPlugin,
  unregisterScheduledTasksForPlugin,
  toTaskTrigger,
  type ScheduledTaskSchedulerPort,
} from "./scheduled-task-bridge"
import {
  listScheduledTaskDefs,
  __resetScheduledTaskRegistryForTesting,
} from "@/lib/plugin/scheduler/scheduled-task-registry"
import type { PluginManifest, PluginScheduledTaskDef } from "@/types/plugin/plugin"
import type { CreateScheduledTaskInput, ScheduledTask } from "@/types/scheduler"

function makeManifest(scheduledTasks: PluginScheduledTaskDef[]): PluginManifest {
  return {
    id: "sched-plugin",
    name: "Sched Plugin",
    version: "0.0.0",
    description: "test",
    type: "frontend",
    permissions: [],
    capabilities: ["scheduler"],
    scheduledTasks,
  } as PluginManifest
}

/** Minimal in-memory fake of the scheduler port. */
function makeFakeScheduler(seed: ScheduledTask[] = []) {
  const tasks: ScheduledTask[] = [...seed]
  let counter = 0
  const port: ScheduledTaskSchedulerPort & { tasks: ScheduledTask[] } = {
    tasks,
    getAllTasks: jest.fn(async () => tasks),
    createTask: jest.fn(async (input: CreateScheduledTaskInput) => {
      const task = { ...input, id: `t${++counter}`, status: "active" } as unknown as ScheduledTask
      tasks.push(task)
      return task
    }),
    updateTask: jest.fn(async (id, input) => {
      const task = tasks.find((candidate) => candidate.id === id)
      if (!task) return null
      Object.assign(task, input)
      if (input.trigger?.type === "interval") {
        task.nextRunAt = new Date(input.trigger.intervalMs ?? 0)
      }
      return task
    }),
    deleteTask: jest.fn(async (id: string) => {
      const i = tasks.findIndex((t) => t.id === id)
      if (i === -1) return false
      tasks.splice(i, 1)
      return true
    }),
    pauseTask: jest.fn(async () => true),
  }
  return port
}

afterEach(() => {
  __resetScheduledTaskRegistryForTesting()
})

describe("toTaskTrigger", () => {
  const trig = (t: PluginScheduledTaskDef["trigger"]): PluginScheduledTaskDef => ({
    name: "x",
    handler: "h",
    trigger: t,
  })

  it("maps cron", () => {
    expect(toTaskTrigger(trig({ type: "cron", expression: "0 9 * * *", timezone: "UTC" }))).toEqual(
      {
        type: "cron",
        cronExpression: "0 9 * * *",
        timezone: "UTC",
      }
    )
  })
  it("maps interval seconds → ms", () => {
    expect(toTaskTrigger(trig({ type: "interval", seconds: 30 }))).toEqual({
      type: "interval",
      intervalMs: 30000,
    })
  })
  it("maps once", () => {
    const result = toTaskTrigger(trig({ type: "once", runAt: "2030-01-01T00:00:00Z" }))
    expect(result.type).toBe("once")
    expect(result.runAt).toBeInstanceOf(Date)
  })
  it("maps event", () => {
    expect(toTaskTrigger(trig({ type: "event", eventType: "thing", eventSource: "src" }))).toEqual({
      type: "event",
      eventType: "thing",
      eventSource: "src",
    })
  })
})

describe("registerScheduledTasksForPlugin", () => {
  it("creates a plugin task per def and records the defs", async () => {
    const scheduler = makeFakeScheduler()
    const manifest = makeManifest([
      { name: "daily", handler: "doDaily", trigger: { type: "interval", seconds: 60 } },
    ])
    const result = await registerScheduledTasksForPlugin(manifest, { scheduler })
    expect(result.created).toBe(1)
    expect(result.updated).toBe(0)
    expect(scheduler.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "plugin",
        name: "daily",
        payload: { pluginId: "sched-plugin", handler: "doDaily" },
      })
    )
    expect(listScheduledTaskDefs()).toHaveLength(1)
  })

  it("is idempotent — skips a def whose task already exists", async () => {
    const scheduler = makeFakeScheduler([
      {
        id: "existing",
        name: "daily",
        type: "plugin",
        trigger: { type: "interval", intervalMs: 60_000 },
        payload: { pluginId: "sched-plugin", handler: "doDaily" },
      } as unknown as ScheduledTask,
    ])
    const manifest = makeManifest([
      { name: "daily", handler: "doDaily", trigger: { type: "interval", seconds: 60 } },
    ])
    const result = await registerScheduledTasksForPlugin(manifest, { scheduler })
    expect(result.created).toBe(0)
    expect(result.skipped).toBe(1)
    expect(scheduler.createTask).not.toHaveBeenCalled()
  })

  it("pauses a freshly-created task when defaultEnabled is false", async () => {
    const scheduler = makeFakeScheduler()
    const manifest = makeManifest([
      {
        name: "off",
        handler: "h",
        defaultEnabled: false,
        trigger: { type: "interval", seconds: 60 },
      },
    ])
    await registerScheduledTasksForPlugin(manifest, { scheduler })
    expect(scheduler.pauseTask).toHaveBeenCalledTimes(1)
  })

  it("no-ops with empty defs (no scheduler access)", async () => {
    const scheduler = makeFakeScheduler()
    const result = await registerScheduledTasksForPlugin(makeManifest([]), { scheduler })
    expect(result).toEqual({ created: 0, skipped: 0, updated: 0, errors: [] })
    expect(scheduler.getAllTasks).not.toHaveBeenCalled()
  })

  it("updates and re-arms an existing task when the manifest trigger changes", async () => {
    const scheduler = makeFakeScheduler([
      {
        id: "existing",
        name: "daily",
        type: "plugin",
        trigger: { type: "interval", intervalMs: 60_000 },
        payload: { pluginId: "sched-plugin", handler: "doDaily" },
      } as unknown as ScheduledTask,
    ])
    const manifest = makeManifest([
      { name: "daily", handler: "doDaily", trigger: { type: "interval", seconds: 300 } },
    ])

    const result = await registerScheduledTasksForPlugin(manifest, { scheduler })

    expect(result.updated).toBe(1)
    expect(scheduler.updateTask).toHaveBeenCalledWith("existing", {
      trigger: { type: "interval", intervalMs: 300_000 },
    })
    expect(scheduler.tasks[0].trigger).toEqual({ type: "interval", intervalMs: 300_000 })
    expect(scheduler.tasks[0].nextRunAt).toEqual(new Date(300_000))
  })
})

describe("unregisterScheduledTasksForPlugin", () => {
  it("deletes every plugin task and clears the def registry", async () => {
    const scheduler = makeFakeScheduler([
      {
        id: "a",
        type: "plugin",
        payload: { pluginId: "sched-plugin", handler: "h" },
      } as unknown as ScheduledTask,
      {
        id: "b",
        type: "plugin",
        payload: { pluginId: "other", handler: "h" },
      } as unknown as ScheduledTask,
    ])
    const manifest = makeManifest([
      { name: "x", handler: "h", trigger: { type: "interval", seconds: 1 } },
    ])
    await registerScheduledTasksForPlugin(manifest, { scheduler })

    const deleted = await unregisterScheduledTasksForPlugin("sched-plugin", { scheduler })
    expect(deleted).toBeGreaterThanOrEqual(1)
    expect(
      scheduler.tasks.some((t) => (t.payload as { pluginId?: string }).pluginId === "sched-plugin")
    ).toBe(false)
    // The other plugin's task survives.
    expect(
      scheduler.tasks.some((t) => (t.payload as { pluginId?: string }).pluginId === "other")
    ).toBe(true)
    expect(listScheduledTaskDefs()).toHaveLength(0)
  })
})
