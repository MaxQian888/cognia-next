import {
  DEFAULT_PERMISSION_POLICY,
  type PluginToolRegistration,
  type ScheduledTask,
  type SchedulerPermissionPolicy,
} from "@cognia/plugin-sdk"
import { createTestPluginContext } from "@cognia/plugin-sdk/testing"

import definition, {
  AGENT_CREATABLE_TYPES,
  createSchedulerTools,
  DELETE_TOOL,
  deleteScheduledTask,
  MANAGE_TOOL,
  parseTrigger,
  PLUGIN_ID,
  RUN_TOOL,
  runScheduledTask,
  runSchedulerToolAction,
  scheduleDigestBot,
  type SchedulerToolDeps,
} from "./index"

const NOW = Date.parse("2026-09-25T00:00:00Z")

function task(over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "t1",
    name: "Nightly digest",
    type: "plan",
    status: "active",
    trigger: { type: "cron", cronExpression: "0 9 * * *" },
    ...over,
  } as ScheduledTask
}

function makeDeps(policyOverrides: Partial<SchedulerPermissionPolicy> = {}) {
  let policy: SchedulerPermissionPolicy = { ...DEFAULT_PERMISSION_POLICY, ...policyOverrides }
  let tasks: ScheduledTask[] = []
  const createTask = jest.fn(async () => task({ id: "new_task", name: "n" }))
  const deleteTask = jest.fn(async () => true)
  const runTaskNow = jest.fn(async () => ({ id: "exec_1", status: "running" }))
  const listTasks = jest.fn(async () => tasks)
  const getPolicy = jest.fn(async () => policy)
  const deps = {
    getPolicy,
    listTasks,
    createTask,
    deleteTask,
    runTaskNow,
  } as unknown as SchedulerToolDeps
  return {
    deps,
    createTask,
    deleteTask,
    runTaskNow,
    listTasks,
    getPolicy,
    setPolicy: (p: Partial<SchedulerPermissionPolicy>) => {
      policy = { ...policy, ...p }
    },
    setTasks: (t: ScheduledTask[]) => {
      tasks = t
    },
  }
}

describe("the agent-tools switch", () => {
  // `agentToolsEnabled` is the user's answer to "may agents touch the schedule
  // at all". Every action — reads included — must honour it.
  it.each([
    [
      "list",
      () => (h: ReturnType<typeof makeDeps>) => runSchedulerToolAction({ action: "list" }, h.deps),
    ],
    [
      "create",
      () => (h: ReturnType<typeof makeDeps>) =>
        runSchedulerToolAction(
          {
            action: "create",
            name: "x",
            taskType: "chat",
            trigger: { type: "cron", cronExpression: "* * * * *" },
          },
          h.deps
        ),
    ],
    [
      "delete",
      () => (h: ReturnType<typeof makeDeps>) => deleteScheduledTask({ taskId: "t1" }, h.deps),
    ],
    ["run", () => (h: ReturnType<typeof makeDeps>) => runScheduledTask({ taskId: "t1" }, h.deps)],
  ])("refuses %s while it is off", async (_name, build) => {
    const h = makeDeps({ agentToolsEnabled: false })
    h.setTasks([task()])
    const result = await build()(h)
    expect(result).toMatchObject({ ok: false, reason: "agent-tools-disabled" })
    expect(h.listTasks).not.toHaveBeenCalled()
    expect(h.createTask).not.toHaveBeenCalled()
    expect(h.deleteTask).not.toHaveBeenCalled()
    expect(h.runTaskNow).not.toHaveBeenCalled()
  })

  it("treats a policy persisted before the field existed as on", async () => {
    const h = makeDeps({ agentToolsEnabled: undefined })
    await expect(runSchedulerToolAction({ action: "list" }, h.deps)).resolves.toMatchObject({
      ok: true,
    })
  })
})

describe("manage_scheduled_task", () => {
  it("lists tasks", async () => {
    const h = makeDeps()
    h.setTasks([task()])
    const r = await runSchedulerToolAction({ action: "list" }, h.deps)
    expect(r).toMatchObject({ ok: true, action: "list", count: 1 })
    expect((r as unknown as { tasks: Array<{ id: string }> }).tasks[0].id).toBe("t1")
  })

  it("attributes a created task to the agent and its session", async () => {
    const h = makeDeps()
    const r = await runSchedulerToolAction(
      {
        action: "create",
        name: "daily plan",
        taskType: "plan",
        trigger: { type: "interval", intervalMinutes: 30 },
        payload: { planId: "p1" },
      },
      h.deps,
      { sessionId: "s1" }
    )
    expect(r).toMatchObject({ ok: true, action: "create", taskId: "new_task" })
    expect(h.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "daily plan",
        type: "plan",
        trigger: expect.objectContaining({ type: "interval", intervalMs: 30 * 60_000 }),
        payload: { planId: "p1" },
        createdBy: { kind: "agent", pluginId: PLUGIN_ID, sessionId: "s1" },
      })
    )
  })

  it("leaves the policy to the host gate and relays its refusal verbatim", async () => {
    // agentAutoCreate / confirmationRequired / the per-agent quota live in
    // `assertTaskWriteAllowed`. The plugin no longer second-guesses them (its
    // old quota counted EVERY task, the user's included).
    const h = makeDeps({ maxTasksPerSource: 1 })
    h.setTasks([task(), task({ id: "t2" })])
    h.createTask.mockRejectedValueOnce(
      new Error("Agents are not allowed to add to your schedule on their own.")
    )
    const r = await runSchedulerToolAction(
      {
        action: "create",
        name: "x",
        taskType: "chat",
        trigger: { type: "cron", cronExpression: "0 9 * * *" },
      },
      h.deps
    )
    expect(r).toEqual({
      ok: false,
      reason: "policy",
      error: "Agents are not allowed to add to your schedule on their own.",
    })
    expect(h.createTask).toHaveBeenCalledTimes(1)
  })

  it("never lets an agent create a script task", async () => {
    const h = makeDeps({ scriptTasksEnabled: true })
    expect(AGENT_CREATABLE_TYPES).not.toContain("script")
    const r = await runSchedulerToolAction(
      {
        action: "create",
        name: "s",
        taskType: "script",
        trigger: { type: "cron", cronExpression: "* * * * *" },
      },
      h.deps
    )
    expect(r.ok).toBe(false)
    expect(h.createTask).not.toHaveBeenCalled()
  })

  it("rejects a missing name or an unsupported task type", async () => {
    const h = makeDeps()
    const trigger = { type: "cron" as const, cronExpression: "* * * * *" }
    expect(
      (await runSchedulerToolAction({ action: "create", taskType: "chat", trigger }, h.deps)).ok
    ).toBe(false)
    expect(
      (
        await runSchedulerToolAction(
          { action: "create", name: "w", taskType: "workflow", trigger },
          h.deps
        )
      ).ok
    ).toBe(false)
    expect(h.createTask).not.toHaveBeenCalled()
  })

  it("rejects an unknown action", async () => {
    const h = makeDeps()
    const r = await runSchedulerToolAction({ action: "bogus" } as never, h.deps)
    expect(r.ok).toBe(false)
  })
})

describe("parseTrigger", () => {
  it("refuses to invent a missing field", () => {
    expect(parseTrigger(undefined)).toMatchObject({ ok: false })
    expect(parseTrigger({ type: "cron" })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/cronExpression/),
    })
    expect(parseTrigger({ type: "interval" })).toMatchObject({ ok: false })
    expect(parseTrigger({ type: "interval", intervalMinutes: 0 })).toMatchObject({ ok: false })
    expect(parseTrigger({ type: "once" })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/runAt/),
    })
    expect(parseTrigger({ type: "event" })).toMatchObject({ ok: false })
    expect(parseTrigger({ type: "weekly" } as never)).toMatchObject({ ok: false })
  })

  it("rejects an unparseable or past runAt and an unknown time zone", () => {
    expect(parseTrigger({ type: "once", runAt: "tomorrow-ish" }, NOW)).toMatchObject({ ok: false })
    expect(parseTrigger({ type: "once", runAt: "2020-01-01T00:00:00Z" }, NOW)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/past/),
    })
    expect(
      parseTrigger({ type: "cron", cronExpression: "0 9 * * *", timezone: "Mars/Olympus" })
    ).toMatchObject({ ok: false })
  })

  it("builds each trigger kind from complete arguments", () => {
    expect(
      parseTrigger({ type: "cron", cronExpression: " 0 9 * * * ", timezone: "Asia/Shanghai" })
    ).toEqual({
      ok: true,
      trigger: { type: "cron", cronExpression: "0 9 * * *", timezone: "Asia/Shanghai" },
    })
    expect(parseTrigger({ type: "interval", intervalMinutes: 2 })).toEqual({
      ok: true,
      trigger: { type: "interval", intervalMs: 120_000 },
    })
    const once = parseTrigger({ type: "once", runAt: "2026-09-26T08:00:00Z" }, NOW)
    expect(once).toEqual({
      ok: true,
      trigger: { type: "once", runAt: new Date("2026-09-26T08:00:00Z") },
    })
    expect(parseTrigger({ type: "event", eventType: "goal.completed" })).toEqual({
      ok: true,
      trigger: { type: "event", eventType: "goal.completed" },
    })
  })
})

describe("delete_scheduled_task", () => {
  it("deletes an existing task", async () => {
    const h = makeDeps()
    h.setTasks([task()])
    await expect(deleteScheduledTask({ taskId: "t1" }, h.deps)).resolves.toMatchObject({
      ok: true,
      action: "delete",
      taskId: "t1",
    })
    expect(h.deleteTask).toHaveBeenCalledWith("t1")
  })

  it("says so when the id names no task, and requires an id", async () => {
    const h = makeDeps()
    await expect(deleteScheduledTask({ taskId: "missing" }, h.deps)).resolves.toMatchObject({
      ok: false,
    })
    await expect(deleteScheduledTask({}, h.deps)).resolves.toMatchObject({ ok: false })
    expect(h.deleteTask).not.toHaveBeenCalled()
  })
})

describe("run_scheduled_task", () => {
  it("runs a task now with the run-now trigger source", async () => {
    const h = makeDeps()
    h.setTasks([task()])
    await expect(runScheduledTask({ taskId: "t1" }, h.deps)).resolves.toMatchObject({
      ok: true,
      action: "run",
      executionId: "exec_1",
    })
    expect(h.runTaskNow).toHaveBeenCalledWith("t1", { triggerSource: "run-now" })
  })

  it("never runs a script task for an agent", async () => {
    const h = makeDeps({ scriptTasksEnabled: true })
    h.setTasks([task({ type: "script", name: "cleanup.sh" })])
    await expect(runScheduledTask({ taskId: "t1" }, h.deps)).resolves.toMatchObject({
      ok: false,
      reason: "script-task",
    })
    expect(h.runTaskNow).not.toHaveBeenCalled()
  })
})

describe("scheduler-tools activation", () => {
  it("registers list/create freely and delete/run behind approval, through ctx.userScheduler", async () => {
    const registered: PluginToolRegistration[] = []
    const { ctx } = createTestPluginContext({
      pluginId: PLUGIN_ID,
      overrides: {
        agent: { registerTool: (tool: PluginToolRegistration) => void registered.push(tool) },
        userScheduler: {
          getPolicy: jest.fn(async () => DEFAULT_PERMISSION_POLICY),
          listTasks: jest.fn(async () => []),
          createTask: jest.fn(),
          deleteTask: jest.fn(),
          runTaskNow: jest.fn(),
        },
      },
    })

    await definition.activate(ctx)
    expect(registered.map((tool) => tool.name)).toEqual([MANAGE_TOOL, DELETE_TOOL, RUN_TOOL])
    for (const tool of registered) expect(Object.hasOwn(tool, "pluginId")).toBe(false)
    const approval = Object.fromEntries(
      registered.map((tool) => [tool.name, tool.definition.requiresApproval])
    )
    expect(approval).toEqual({ [MANAGE_TOOL]: false, [DELETE_TOOL]: true, [RUN_TOOL]: true })
    expect(registered.find((tool) => tool.name === RUN_TOOL)?.definition.timeoutMs).toBe(600_000)

    const manage = registered[0]!
    await expect(manage.execute({ action: "list" }, { config: {} })).resolves.toEqual({
      ok: true,
      action: "list",
      count: 0,
      tasks: [],
    })
    expect(ctx.userScheduler.listTasks).toHaveBeenCalledTimes(1)
  })

  it("turns a thrown dependency into a structured error", async () => {
    const h = makeDeps()
    h.getPolicy.mockRejectedValueOnce(new Error("settings unavailable"))
    const [manage] = createSchedulerTools(h.deps)
    await expect(manage!.execute({ action: "list" }, { config: {} })).resolves.toEqual({
      ok: false,
      error: "settings unavailable",
    })
  })

  it("releases the Bot's captured context when the activation is disposed", async () => {
    const { ctx, dispose } = createTestPluginContext({ pluginId: PLUGIN_ID })
    await definition.activate(ctx)
    await dispose()
    const botCtx = {
      config: {},
      step: { run: async <T>(_: string, fn: () => Promise<T>) => fn() },
      progress: jest.fn(),
      log: jest.fn(),
    }
    await expect(scheduleDigestBot(botCtx as never)).rejects.toThrow("not active")
  })
})
