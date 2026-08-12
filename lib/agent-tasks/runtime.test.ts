import type { AgentTask } from "@/types/agent/agent-task"
import {
  cancelAgentTask,
  ensureAgentTaskSchedule,
  reconcileAgentTaskRuntime,
  runAgentTaskNow,
  type AgentTaskRuntimeDeps,
} from "./runtime"

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "task-1",
    agentId: "agent-1",
    title: "Research",
    description: "Find primary sources",
    status: "pending",
    priority: "high",
    dependencies: [],
    tags: [],
    order: 0,
    approvalPolicy: "manual",
    latestAttemptNo: 0,
    comments: [],
    createdAt: 1,
    updatedAt: 1,
    revision: 1,
    ...overrides,
  }
}

function fixture(row = task()) {
  const createTask = jest.fn(async () => ({ id: "scheduled-1" }))
  const runTaskNowMock = jest.fn(async () => ({ id: "execution-1", status: "completed" }))
  const deleteTask = jest.fn(async () => true)
  const bindSchedule = jest.fn(async () => undefined)
  const moveTask = jest.fn(async () => row)
  const getExecution = jest.fn<
    ReturnType<AgentTaskRuntimeDeps["getExecution"]>,
    Parameters<AgentTaskRuntimeDeps["getExecution"]>
  >(async () => null)
  const reconcile = jest.fn<
    ReturnType<AgentTaskRuntimeDeps["reconcile"]>,
    Parameters<AgentTaskRuntimeDeps["reconcile"]>
  >(async () => ({ interrupted: [], settled: [] }))
  return {
    deps: {
      now: () => 100,
      getTask: async () => row,
      bindSchedule,
      moveTask,
      createTask,
      runTaskNow: runTaskNowMock,
      pauseTask: jest.fn(async () => true),
      resumeTask: jest.fn(async () => true),
      deleteTask,
      getExecution,
      reconcile,
    },
    createTask,
    runTaskNowMock,
    deleteTask,
    bindSchedule,
    moveTask,
    reconcile,
    getExecution,
  }
}

describe("single-Agent task Scheduler runtime", () => {
  it("creates one Scheduler definition with Agent ownership and overlap protection", async () => {
    const fx = fixture(task({ scheduledFor: 1_000 }))
    const id = await ensureAgentTaskSchedule("task-1", fx.deps)

    expect(id).toBe("scheduled-1")
    expect(fx.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "agent",
        trigger: { type: "once", runAt: new Date(1_000) },
        payload: expect.objectContaining({
          agentTaskId: "task-1",
          characterId: "agent-1",
          prompt: "Find primary sources",
        }),
        config: expect.objectContaining({ overlapPolicy: "skip", allowConcurrent: false }),
      })
    )
    expect(fx.bindSchedule).toHaveBeenCalledWith("task-1", "scheduled-1", 100)
  })

  it("runs now through the same Scheduler executor used by background fires", async () => {
    const fx = fixture()
    await runAgentTaskNow("task-1", fx.deps)
    expect(fx.runTaskNowMock).toHaveBeenCalledWith("scheduled-1")
  })

  it("cancels the Scheduler owner before moving the card", async () => {
    const fx = fixture(task({ scheduledTaskId: "scheduled-existing", status: "in_progress" }))
    await cancelAgentTask("task-1", fx.deps)
    expect(fx.deleteTask).toHaveBeenCalledWith("scheduled-existing")
    expect(fx.moveTask).toHaveBeenCalledWith("task-1", "cancelled", 100)
  })

  it("reconciles persisted attempts against Scheduler execution history", async () => {
    const fx = fixture()
    await reconcileAgentTaskRuntime(fx.deps)
    expect(fx.reconcile).toHaveBeenCalledWith(expect.any(Function), 100)
  })

  it("normalizes skipped Scheduler executions to cancelled attempts", async () => {
    const fx = fixture()
    fx.getExecution.mockResolvedValue({
      id: "execution-1",
      taskId: "scheduled-1",
      taskName: "Research",
      taskType: "agent",
      status: "skipped",
      output: { reason: "overlap" },
      error: undefined,
      retryAttempt: 0,
      startedAt: new Date(0),
      logs: [],
    })

    await reconcileAgentTaskRuntime(fx.deps)
    const resolveExecution = fx.reconcile.mock.calls[0][0]

    await expect(resolveExecution("execution-1")).resolves.toEqual({
      status: "cancelled",
      output: { reason: "overlap" },
      error: undefined,
    })
  })

  it("keeps missing Scheduler executions unresolved", async () => {
    const fx = fixture()
    await reconcileAgentTaskRuntime(fx.deps)
    const resolveExecution = fx.reconcile.mock.calls[0][0]

    await expect(resolveExecution("missing")).resolves.toBeNull()
  })
})
