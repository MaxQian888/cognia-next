/** @jest-environment jsdom */
/**
 * The store and the data source are mocked, so what is under test is this
 * module's own behaviour: which store method each function reaches for, the
 * load-before-read in `listUserScheduledTasks`, the `run-now` default, the
 * attribution rules (a plugin may write as itself or for an agent, never as
 * the user), and the write gate on every write.
 */

const state = {
  permissionPolicy: { agentAutoCreate: true } as unknown,
  tasks: [] as unknown[],
  loadTasks: jest.fn(async () => undefined),
  createTask: jest.fn(async (_input: unknown) => ({ id: "t1" })),
  updateTask: jest.fn(async (_taskId: string, _input: unknown) => ({ id: "t1" })),
  deleteTask: jest.fn(async (_taskId: string) => true),
  pauseTask: jest.fn(async (_taskId: string) => true),
  resumeTask: jest.fn(async (_taskId: string) => true),
  runTaskNow: jest.fn(async (_taskId: string, _opts?: unknown) => ({ id: "e1" })),
  cancelExecution: jest.fn(async (_executionId: string) => ({ cancelled: true })),
}

jest.mock("@/stores/scheduler/scheduler-store", () => ({
  useSchedulerStore: { getState: () => state },
}))

const source = {
  host: "local" as "local" | "remote",
  getTask: jest.fn(async (taskId: string) =>
    taskId === "missing" ? null : ({ id: taskId, type: "chat" } as unknown)
  ),
  listTasks: jest.fn(async (_filter?: unknown) => [] as unknown[]),
  getTaskExecutions: jest.fn(async (..._args: unknown[]) => [] as unknown[]),
  getRecentExecutions: jest.fn(async (_limit: number) => [] as unknown[]),
}
jest.mock("@/lib/scheduler/scheduler-data-source", () => ({
  getSchedulerDataSource: () => source,
}))

const getExecution = jest.fn(async (_id: string) => null as unknown)
jest.mock("@/lib/scheduler/scheduler-db", () => ({
  schedulerDb: { getExecution: (id: string) => getExecution(id) },
}))

const getQueuedStartTaskId = jest.fn((_id: string) => undefined as string | undefined)
jest.mock("@/lib/scheduler/task-scheduler", () => ({
  getTaskScheduler: () => ({ getQueuedStartTaskId }),
}))

// The gate has its own suite in `lib/scheduler/write-authority.test.ts`; here
// it is a spy, so these tests can say what each write asked it, and stubbed
// to refuse where the refusal itself is the subject.
const assertTaskWriteAllowed = jest.fn(async (_request: unknown) => undefined)
// The policy loader reads AppSettings; stubbed so the suite can tell a fresh
// read apart from the store's snapshot.
const loadSchedulerPolicy = jest.fn(async () => ({ agentToolsEnabled: false }) as unknown)
jest.mock("@/lib/scheduler/write-authority", () => ({
  assertTaskWriteAllowed: (request: unknown) => assertTaskWriteAllowed(request),
  loadSchedulerPolicy: () => loadSchedulerPolicy(),
}))

import {
  createUserScheduledTask,
  createUserSchedulerAPI,
  deleteUserScheduledTask,
  getSchedulerPermissionPolicy,
  listUserScheduledTasks,
  runUserScheduledTaskNow,
} from "./scheduler-tasks"

const PLUGIN = "plugin-a"

beforeEach(() => {
  jest.clearAllMocks()
  state.tasks = []
  source.host = "local"
  assertTaskWriteAllowed.mockResolvedValue(undefined)
})

describe("reads", () => {
  it("reads the permission policy fresh from settings, not the store snapshot", async () => {
    // The store's `permissionPolicy` is `DEFAULT_PERMISSION_POLICY` until it is
    // hydrated, which says agents may manage the schedule. A plugin gating its
    // agent tools on that snapshot let them through after the user said no.
    await expect(getSchedulerPermissionPolicy()).resolves.toEqual({ agentToolsEnabled: false })
    expect(loadSchedulerPolicy).toHaveBeenCalledTimes(1)
  })

  it("loads before reading, so a fresh renderer never reports an empty schedule", async () => {
    state.loadTasks.mockImplementation(async () => {
      state.tasks = [{ id: "t1" }]
    })
    await expect(listUserScheduledTasks()).resolves.toEqual([{ id: "t1" }])
    expect(state.loadTasks).toHaveBeenCalledTimes(1)
  })

  it("still returns the current rows when the load fails", async () => {
    state.tasks = [{ id: "cached" }]
    state.loadTasks.mockRejectedValueOnce(new Error("offline"))
    await expect(listUserScheduledTasks()).resolves.toEqual([{ id: "cached" }])
  })

  it("getTask reads through the data source and answers null for an unknown id", async () => {
    const api = createUserSchedulerAPI(PLUGIN)
    await expect(api.getTask("t9")).resolves.toEqual({ id: "t9", type: "chat" })
    await expect(api.getTask("missing")).resolves.toBeNull()
  })

  it("pages executions with the before cursor as an ISO string", async () => {
    const api = createUserSchedulerAPI(PLUGIN)
    await api.listExecutions("t1", { limit: 5, before: "2026-10-01T00:00:00.000Z" })
    expect(source.getTaskExecutions).toHaveBeenCalledWith("t1", 5, "2026-10-01T00:00:00.000Z")
    await api.listExecutions("t1")
    expect(source.getTaskExecutions).toHaveBeenLastCalledWith("t1", 50, undefined)
    await expect(api.listExecutions("t1", { limit: 500 })).rejects.toThrow(/1 to 200/)
    await expect(api.listExecutions("t1", { before: "not a date" })).rejects.toThrow(/valid date/)
  })

  it("looks an execution up locally by id", async () => {
    getExecution.mockResolvedValueOnce({ id: "e1", taskId: "t1" })
    await expect(createUserSchedulerAPI(PLUGIN).getExecution("e1")).resolves.toEqual({
      id: "e1",
      taskId: "t1",
    })
  })

  it("on a paired host, finds a recent run and refuses to guess about an old one", async () => {
    source.host = "remote"
    source.getRecentExecutions.mockResolvedValue([{ id: "e2", taskId: "t1" }])
    const api = createUserSchedulerAPI(PLUGIN)
    await expect(api.getExecution("e2")).resolves.toEqual({ id: "e2", taskId: "t1" })
    expect(source.getRecentExecutions).toHaveBeenCalledWith(200)
    await expect(api.getExecution("old")).rejects.toThrow(/listExecutions/)
  })

  it("projects upcoming runs of one task, and merges every active task in time order", async () => {
    const now = Date.now()
    source.getTask.mockResolvedValueOnce({
      id: "t1",
      name: "Hourly",
      type: "chat",
      status: "active",
      trigger: { type: "interval", intervalMs: 3_600_000 },
      nextRunAt: new Date(now + 60_000),
    })
    const api = createUserSchedulerAPI(PLUGIN)
    const one = await api.getUpcoming("t1", 3)
    expect(one).toHaveLength(3)
    expect(one[0]).toMatchObject({ taskId: "t1", taskName: "Hourly", taskType: "chat" })
    expect(one[1].at.getTime() - one[0].at.getTime()).toBe(3_600_000)

    source.listTasks.mockResolvedValueOnce([
      {
        id: "a",
        name: "A",
        type: "chat",
        status: "active",
        trigger: { type: "interval", intervalMs: 120_000 },
      },
      {
        id: "b",
        name: "B",
        type: "agent",
        status: "active",
        trigger: { type: "interval", intervalMs: 90_000 },
      },
      { id: "e", name: "E", type: "chat", status: "active", trigger: { type: "event" } },
    ])
    const merged = await api.getUpcoming(undefined, 3)
    expect(source.listTasks).toHaveBeenCalledWith({ statuses: ["active"] })
    expect(merged.map((run) => run.taskId)).toEqual(["b", "a", "b"])
  })

  it("has no upcoming runs for a paused task, and validates count", async () => {
    source.getTask.mockResolvedValueOnce({
      id: "t1",
      name: "Paused",
      type: "chat",
      status: "paused",
      trigger: { type: "interval", intervalMs: 60_000 },
    })
    const api = createUserSchedulerAPI(PLUGIN)
    await expect(api.getUpcoming("t1")).resolves.toEqual([])
    await expect(api.getUpcoming("t1", 0)).rejects.toThrow(/1 to 100/)
  })
})

describe("createTask attribution", () => {
  const input = { name: "n", type: "chat", trigger: { type: "interval", intervalMs: 60_000 } }

  it("refuses a create the user's policy does not permit", async () => {
    // This module used to tell authors in a comment that they "MUST consult"
    // the policy first, and do nothing to make that true.
    assertTaskWriteAllowed.mockRejectedValue(new Error("Agents are not allowed"))
    await expect(createUserScheduledTask(PLUGIN, input as never)).rejects.toThrow(
      "Agents are not allowed"
    )
    expect(state.createTask).not.toHaveBeenCalled()
  })

  it("attributes an unattributed write to the calling plugin", async () => {
    await createUserScheduledTask(PLUGIN, input as never)
    expect(assertTaskWriteAllowed).toHaveBeenCalledWith(
      expect.objectContaining({ taskType: "chat", source: "plugin", pluginId: PLUGIN })
    )
    expect(state.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ createdBy: { kind: "plugin", pluginId: PLUGIN } })
    )
  })

  it("keeps an agent attribution, and stamps it with the caller's plugin id", async () => {
    await createUserScheduledTask(PLUGIN, {
      ...input,
      createdBy: { kind: "agent", sessionId: "s1", pluginId: "someone-else" },
    } as never)
    expect(assertTaskWriteAllowed).toHaveBeenCalledWith(
      expect.objectContaining({ source: "agent", sessionId: "s1", pluginId: PLUGIN })
    )
    expect(state.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        createdBy: { kind: "agent", pluginId: PLUGIN, sessionId: "s1" },
      })
    )
  })

  it.each(["user", "system", "admin"])("refuses to write as %s", async (kind) => {
    // The gate exempts the user entirely, so this attribution would walk a
    // plugin past every setting the user has.
    await expect(
      createUserScheduledTask(PLUGIN, { ...input, createdBy: { kind } } as never)
    ).rejects.toThrow(/not as/)
    expect(assertTaskWriteAllowed).not.toHaveBeenCalled()
    expect(state.createTask).not.toHaveBeenCalled()
  })

  it("revives wire dates, so a Python plugin's ISO strings are stored as dates", async () => {
    await createUserScheduledTask(PLUGIN, {
      name: "n",
      type: "chat",
      trigger: { type: "once", runAt: "2030-01-01T00:00:00.000Z" },
      endAt: "2030-02-01T00:00:00.000Z",
    } as never)
    const passed = state.createTask.mock.calls[0][0] as {
      trigger: { runAt: Date }
      endAt: Date
    }
    expect(passed.trigger.runAt).toBeInstanceOf(Date)
    expect(passed.endAt).toBeInstanceOf(Date)
  })
})

describe("writes to existing tasks", () => {
  const api = () => createUserSchedulerAPI(PLUGIN)

  const writes: Array<
    [string, (a: ReturnType<typeof api>, options?: unknown) => Promise<unknown>]
  > = [
    ["updateTask", (a, options) => a.updateTask("t1", { name: "x" }, options as never)],
    ["deleteTask", (a, options) => a.deleteTask("t1", options as never)],
    ["pauseTask", (a, options) => a.pauseTask("t1", options as never)],
    ["resumeTask", (a, options) => a.resumeTask("t1", options as never)],
    ["runTaskNow", (a, options) => a.runTaskNow("t1", options as never)],
  ]

  it.each(writes)("%s passes the mutate gate with the task's real type", async (_name, call) => {
    await call(api())
    expect(assertTaskWriteAllowed).toHaveBeenCalledWith({
      taskType: "chat",
      source: "plugin",
      operation: "mutate",
      pluginId: PLUGIN,
    })
  })

  it.each(writes)("%s is gated as the agent when an agent is the actor", async (_name, call) => {
    await call(api(), { actor: { kind: "agent", sessionId: "s1" } })
    expect(assertTaskWriteAllowed).toHaveBeenCalledWith({
      taskType: "chat",
      source: "agent",
      operation: "mutate",
      pluginId: PLUGIN,
      sessionId: "s1",
    })
  })

  it.each(writes)("%s throws when the policy refuses, and writes nothing", async (_n, call) => {
    assertTaskWriteAllowed.mockRejectedValue(new Error("Agents are not allowed"))
    await expect(call(api())).rejects.toThrow("Agents are not allowed")
    for (const method of [
      state.updateTask,
      state.deleteTask,
      state.pauseTask,
      state.resumeTask,
      state.runTaskNow,
    ]) {
      expect(method).not.toHaveBeenCalled()
    }
  })

  it.each(writes)("%s refuses a user actor before touching anything", async (_name, call) => {
    await expect(call(api(), { actor: { kind: "user" } })).rejects.toThrow(/not as "user"/)
    expect(source.getTask).not.toHaveBeenCalled()
    expect(assertTaskWriteAllowed).not.toHaveBeenCalled()
  })

  it("answers not-found without asking the gate", async () => {
    const a = api()
    await expect(a.updateTask("missing", { name: "x" })).resolves.toBeNull()
    await expect(a.deleteTask("missing")).resolves.toBe(false)
    await expect(a.pauseTask("missing")).resolves.toBe(false)
    await expect(a.resumeTask("missing")).resolves.toBe(false)
    await expect(a.runTaskNow("missing")).resolves.toBeNull()
    expect(assertTaskWriteAllowed).not.toHaveBeenCalled()
  })

  it("passes writes through to the store", async () => {
    const a = api()
    await a.updateTask("t1", { name: "renamed", endAt: "2030-01-01T00:00:00.000Z" } as never)
    expect(state.updateTask).toHaveBeenCalledWith("t1", {
      name: "renamed",
      endAt: new Date("2030-01-01T00:00:00.000Z"),
    })
    await a.updateTask("t1", { endAt: null })
    expect(state.updateTask).toHaveBeenLastCalledWith("t1", { endAt: null })
    await expect(deleteUserScheduledTask(PLUGIN, "t1")).resolves.toBe(true)
    expect(state.deleteTask).toHaveBeenCalledWith("t1")
    await a.pauseTask("t1")
    expect(state.pauseTask).toHaveBeenCalledWith("t1")
    await a.resumeTask("t1")
    expect(state.resumeTask).toHaveBeenCalledWith("t1")
  })

  it("defaults the trigger source to run-now, and lets a caller override it", async () => {
    await runUserScheduledTaskNow(PLUGIN, "t1")
    expect(state.runTaskNow).toHaveBeenCalledWith("t1", { triggerSource: "run-now" })
    await runUserScheduledTaskNow(PLUGIN, "t1", { triggerSource: "remote" })
    expect(state.runTaskNow).toHaveBeenLastCalledWith("t1", { triggerSource: "remote" })
  })
})

describe("cancelExecution", () => {
  it("gates the cancel on the run's task and returns the store's outcome", async () => {
    getExecution.mockResolvedValueOnce({ id: "e1", taskId: "t1", status: "running" })
    await expect(
      createUserSchedulerAPI(PLUGIN).cancelExecution("e1", {
        actor: { kind: "agent", sessionId: "s1" },
      })
    ).resolves.toEqual({ cancelled: true })
    expect(assertTaskWriteAllowed).toHaveBeenCalledWith(
      expect.objectContaining({ taskType: "chat", source: "agent", operation: "mutate" })
    )
    expect(state.cancelExecution).toHaveBeenCalledWith("e1")
  })

  it("reaches a buffered start through the scheduler's queue", async () => {
    getQueuedStartTaskId.mockReturnValueOnce("t1")
    await expect(createUserSchedulerAPI(PLUGIN).cancelExecution("queued")).resolves.toEqual({
      cancelled: true,
    })
    expect(state.cancelExecution).toHaveBeenCalledWith("queued")
  })

  it("says not-found and already-settled without asking the gate", async () => {
    const api = createUserSchedulerAPI(PLUGIN)
    await expect(api.cancelExecution("nope")).resolves.toEqual({
      cancelled: false,
      reason: "not-found",
    })
    getExecution.mockResolvedValueOnce({ id: "e1", taskId: "t1", status: "completed" })
    await expect(api.cancelExecution("e1")).resolves.toEqual({
      cancelled: false,
      reason: "already-settled",
      status: "completed",
    })
    expect(assertTaskWriteAllowed).not.toHaveBeenCalled()
    expect(state.cancelExecution).not.toHaveBeenCalled()
  })

  it("throws a policy refusal instead of cancelling", async () => {
    getExecution.mockResolvedValueOnce({ id: "e1", taskId: "t1", status: "running" })
    assertTaskWriteAllowed.mockRejectedValue(new Error("Agents are not allowed"))
    await expect(
      createUserSchedulerAPI(PLUGIN).cancelExecution("e1", { actor: { kind: "agent" } })
    ).rejects.toThrow("Agents are not allowed")
    expect(state.cancelExecution).not.toHaveBeenCalled()
  })
})

describe("facade", () => {
  it("mounts every operation", () => {
    expect(Object.keys(createUserSchedulerAPI(PLUGIN)).sort()).toEqual(
      [
        "cancelExecution",
        "createTask",
        "deleteTask",
        "getExecution",
        "getPolicy",
        "getTask",
        "getUpcoming",
        "listExecutions",
        "listTasks",
        "pauseTask",
        "resumeTask",
        "runTaskNow",
        "updateTask",
      ].sort()
    )
  })
})
