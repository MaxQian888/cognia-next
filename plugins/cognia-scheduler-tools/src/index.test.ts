import {
  runSchedulerToolAction,
  type ManageScheduledTaskArgs,
  type SchedulerToolDeps,
} from "./index"
import { DEFAULT_PERMISSION_POLICY, type SchedulerPermissionPolicy } from "@/types/scheduler"

function makeDeps(overrides: Partial<SchedulerToolDeps> = {}): {
  deps: SchedulerToolDeps
  createTask: jest.Mock
  deleteTask: jest.Mock
  runTaskNow: jest.Mock
  loadTasks: jest.Mock
  setPolicy: (p: Partial<SchedulerPermissionPolicy>) => void
  setTasks: (t: unknown[]) => void
} {
  let policy: SchedulerPermissionPolicy = { ...DEFAULT_PERMISSION_POLICY }
  let tasks: unknown[] = []
  const createTask = jest.fn(async () => ({ id: "new_task", name: "n" }))
  const deleteTask = jest.fn(async () => true)
  const runTaskNow = jest.fn(async () => ({ id: "exec_1" }))
  const loadTasks = jest.fn(async () => undefined)
  const deps: SchedulerToolDeps = {
    getPolicy: () => policy,
    getTasks: () => tasks as never,
    createTask: createTask as never,
    deleteTask,
    runTaskNow: runTaskNow as never,
    loadTasks,
    ...overrides,
  }
  return {
    deps,
    createTask,
    deleteTask,
    runTaskNow,
    loadTasks,
    setPolicy: (p) => {
      policy = { ...policy, ...p }
    },
    setTasks: (t) => {
      tasks = t
    },
  }
}

const run = (args: ManageScheduledTaskArgs, deps: SchedulerToolDeps) =>
  runSchedulerToolAction(args, deps)

describe("runSchedulerToolAction", () => {
  it("lists tasks", async () => {
    const h = makeDeps()
    h.setTasks([{ id: "t1", name: "A", type: "plan", status: "active", trigger: { type: "cron" } }])
    const r = await run({ action: "list" }, h.deps)
    expect(r.ok).toBe(true)
    expect(h.loadTasks).toHaveBeenCalled()
    if (r.ok) {
      expect(r.count).toBe(1)
      expect((r.tasks as Array<{ id: string }>)[0].id).toBe("t1")
    }
  })

  it("cancels a task", async () => {
    const h = makeDeps()
    const r = await run({ action: "cancel", taskId: "t1" }, h.deps)
    expect(r.ok).toBe(true)
    expect(h.deleteTask).toHaveBeenCalledWith("t1")
  })

  it("requires taskId for cancel", async () => {
    const h = makeDeps()
    const r = await run({ action: "cancel" }, h.deps)
    expect(r.ok).toBe(false)
  })

  it("runs a task now", async () => {
    const h = makeDeps()
    const r = await run({ action: "run", taskId: "t1" }, h.deps)
    expect(r.ok).toBe(true)
    expect(h.runTaskNow).toHaveBeenCalledWith("t1", { triggerSource: "run-now" })
  })

  it("blocks create when agentAutoCreate is off (default)", async () => {
    const h = makeDeps()
    const r = await run(
      { action: "create", name: "x", taskType: "chat", trigger: { type: "cron" } },
      h.deps
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.needsConfirmation).toBe(true)
    expect(h.createTask).not.toHaveBeenCalled()
  })

  it("returns needsConfirmation for confirmation-required types", async () => {
    const h = makeDeps()
    h.setPolicy({ agentAutoCreate: true })
    const r = await run(
      { action: "create", name: "g", taskType: "goal", trigger: { type: "cron" } },
      h.deps
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.needsConfirmation).toBe(true)
  })

  it("creates an allowed task when policy permits", async () => {
    const h = makeDeps()
    h.setPolicy({ agentAutoCreate: true, confirmationRequired: [] })
    const r = await run(
      {
        action: "create",
        name: "daily plan",
        taskType: "plan",
        trigger: { type: "interval", intervalMinutes: 30 },
        payload: { planId: "p1" },
      },
      h.deps
    )
    expect(r.ok).toBe(true)
    expect(h.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "daily plan",
        type: "plan",
        trigger: expect.objectContaining({ type: "interval", intervalMs: 30 * 60_000 }),
        payload: { planId: "p1" },
      })
    )
  })

  it("rejects script when scriptTasksEnabled is false", async () => {
    const h = makeDeps()
    h.setPolicy({ agentAutoCreate: true, confirmationRequired: [], scriptTasksEnabled: false })
    const r = await run(
      { action: "create", name: "s", taskType: "script", trigger: { type: "cron" } },
      h.deps
    )
    expect(r.ok).toBe(false)
  })

  it("rejects an unsupported task type", async () => {
    const h = makeDeps()
    h.setPolicy({ agentAutoCreate: true, confirmationRequired: [] })
    const r = await run(
      { action: "create", name: "w", taskType: "workflow", trigger: { type: "cron" } },
      h.deps
    )
    expect(r.ok).toBe(false)
  })

  it("enforces the per-source task limit", async () => {
    const h = makeDeps()
    h.setPolicy({ agentAutoCreate: true, confirmationRequired: [], maxTasksPerSource: 1 })
    h.setTasks([{ id: "t1" }])
    const r = await run(
      { action: "create", name: "x", taskType: "chat", trigger: { type: "cron" } },
      h.deps
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/limit/)
  })

  it("rejects an unknown action", async () => {
    const h = makeDeps()
    const r = await run({ action: "bogus" } as never, h.deps)
    expect(r.ok).toBe(false)
  })
})
