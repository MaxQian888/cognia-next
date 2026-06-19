const dispatchStructuredMock = jest.fn()
jest.mock("./structured-dispatch", () => ({
  dispatchStructured: (...args: unknown[]) => dispatchStructuredMock(...args),
}))
const awaitReplanApprovalMock = jest.fn()
jest.mock("./replan-gate", () => ({
  awaitReplanApproval: (...args: unknown[]) => awaitReplanApprovalMock(...args),
}))
const readDependencyResultsMock = jest.fn((..._args: unknown[]) => [] as unknown[])
jest.mock("./shared-memory-orchestrator", () => ({
  readDependencyResults: (...args: unknown[]) => readDependencyResultsMock(...args),
}))

import { runReplanCheckpoint } from "./replan-checkpoint"
import { continueDecision, type ReplanDecision } from "./replan-schema"
import type { TeamRunContext } from "./team-run-context"
import type { AgentTeamTask, CreateTaskInput } from "@/types/agent/agent-team"

beforeEach(() => {
  dispatchStructuredMock.mockReset()
  awaitReplanApprovalMock.mockReset()
  readDependencyResultsMock.mockReset()
  readDependencyResultsMock.mockReturnValue([])
})

const task = (id: string, deps: string[] = [], order = 0): AgentTeamTask =>
  ({
    id,
    teamId: "team1",
    title: id,
    description: `desc ${id}`,
    status: "pending",
    priority: "normal",
    dependencies: deps,
    tags: [],
    createdAt: new Date(),
    order,
  }) as AgentTeamTask

function makeCtx(
  configOverrides: Record<string, unknown> = {},
  teammateIds: string[] = ["lead", "w1", "w2"]
) {
  const setTaskStatus = jest.fn()
  const updateTask = jest.fn()
  let counter = 0
  const addTask = jest.fn((input: CreateTaskInput) => {
    counter += 1
    return {
      ...task(`new-${counter}`),
      title: input.title,
      description: input.description,
      assignedTo: input.assignedTo,
      dependencies: input.dependencies ?? [],
      expectedOutput: input.expectedOutput,
    } as AgentTeamTask
  })
  const notify = jest.fn()
  const ctx = {
    runId: "run1",
    teamId: "team1",
    team: {
      id: "team1",
      name: "Team",
      task: "do a thing",
      teammateIds,
      config: { adaptiveReplan: { enabled: true, ...configOverrides } },
    },
    notifier: { notify, suspend: jest.fn(), resume: jest.fn() },
    storeWriter: {
      setTaskStatus,
      updateTask,
      addTask,
      addMessage: jest.fn(),
      updateTeammate: jest.fn(),
    },
  } as unknown as TeamRunContext
  return { ctx, setTaskStatus, updateTask, addTask, notify }
}

const decide = (d: Partial<ReplanDecision>): ReplanDecision => ({
  action: "continue",
  reasoning: "r",
  newTasks: [],
  cancelTaskIds: [],
  reorderTaskIds: [],
  ...d,
})

describe("runReplanCheckpoint", () => {
  it("continue leaves the plan untouched and writes no store changes", async () => {
    const { ctx, setTaskStatus, addTask } = makeCtx()
    const real = await runReplanCheckpoint({
      teamCtx: ctx,
      runId: "run1",
      justRanTaskIds: ["t1"],
      remaining: [task("t2"), task("t3")],
      dispatch: async () => decide({ action: "continue" }),
    })
    expect(real.finish).toBe(false)
    expect(real.remaining).toHaveLength(2)
    expect(setTaskStatus).not.toHaveBeenCalled()
    expect(addTask).not.toHaveBeenCalled()
  })

  it("fails open to continue when the lead dispatch throws", async () => {
    const { ctx } = makeCtx()
    const out = await runReplanCheckpoint({
      teamCtx: ctx,
      runId: "run1",
      justRanTaskIds: ["t1"],
      remaining: [task("t2")],
      dispatch: async () => {
        throw new Error("lead down")
      },
    })
    expect(out.decision.action).toBe("continue")
    expect(out.remaining).toHaveLength(1)
  })

  it("injects new tasks, resolves dependsOn titles + ids, and caps the count", async () => {
    const { ctx, addTask } = makeCtx({ maxInjectedTasksPerCheckpoint: 2 })
    const out = await runReplanCheckpoint({
      teamCtx: ctx,
      runId: "run1",
      justRanTaskIds: ["t1"],
      remaining: [task("t2")],
      dispatch: async () =>
        decide({
          action: "inject",
          newTasks: [
            { title: "A", description: "da", dependsOn: ["t1", "ghost"] },
            { title: "B", description: "db", dependsOn: ["A"] },
            { title: "C", description: "dc", dependsOn: [] }, // over the cap → dropped
          ],
        }),
    })
    expect(addTask).toHaveBeenCalledTimes(2)
    // A keeps the valid existing dep t1, drops the unknown "ghost".
    expect(addTask.mock.calls[0]![0].dependencies).toEqual(["t1"])
    // B's dependsOn "A" resolves to the freshly-created A id.
    expect(addTask.mock.calls[1]![0].dependencies).toEqual(["new-1"])
    expect(out.remaining).toHaveLength(3) // t2 + A + B
  })

  it("drops assignedTo that is not on the roster", async () => {
    const { ctx, addTask } = makeCtx({}, ["lead", "w1"])
    await runReplanCheckpoint({
      teamCtx: ctx,
      runId: "run1",
      justRanTaskIds: [],
      remaining: [],
      dispatch: async () =>
        decide({
          action: "inject",
          newTasks: [
            { title: "A", description: "da", assignedTo: "ghost", dependsOn: [] },
            { title: "B", description: "db", assignedTo: "w1", dependsOn: [] },
          ],
        }),
    })
    expect(addTask.mock.calls[0]![0].assignedTo).toBeUndefined()
    expect(addTask.mock.calls[1]![0].assignedTo).toBe("w1")
  })

  it("cancels listed remaining tasks and removes them from the plan", async () => {
    const { ctx, setTaskStatus } = makeCtx()
    const out = await runReplanCheckpoint({
      teamCtx: ctx,
      runId: "run1",
      justRanTaskIds: ["t1"],
      remaining: [task("t2"), task("t3"), task("t4")],
      dispatch: async () => decide({ action: "cancel", cancelTaskIds: ["t3"] }),
    })
    expect(setTaskStatus).toHaveBeenCalledWith("t3", "cancelled")
    expect(out.remaining.map((t) => t.id)).toEqual(["t2", "t4"])
  })

  it("reorders the remaining plan on a valid permutation", async () => {
    const { ctx, updateTask } = makeCtx()
    const out = await runReplanCheckpoint({
      teamCtx: ctx,
      runId: "run1",
      justRanTaskIds: [],
      remaining: [task("t2"), task("t3"), task("t4")],
      dispatch: async () => decide({ action: "reorder", reorderTaskIds: ["t4", "t2", "t3"] }),
    })
    expect(out.remaining.map((t) => t.id)).toEqual(["t4", "t2", "t3"])
    expect(updateTask).toHaveBeenCalledWith("t4", { order: 0 })
    expect(updateTask).toHaveBeenCalledWith("t2", { order: 1 })
  })

  it("ignores a reorder that is not a permutation of the remaining ids", async () => {
    const { ctx, updateTask } = makeCtx()
    const out = await runReplanCheckpoint({
      teamCtx: ctx,
      runId: "run1",
      justRanTaskIds: [],
      remaining: [task("t2"), task("t3")],
      dispatch: async () => decide({ action: "reorder", reorderTaskIds: ["t2"] }),
    })
    expect(out.remaining.map((t) => t.id)).toEqual(["t2", "t3"])
    expect(updateTask).not.toHaveBeenCalled()
  })

  it("finish cancels every remaining task and clears the plan", async () => {
    const { ctx, setTaskStatus } = makeCtx()
    const out = await runReplanCheckpoint({
      teamCtx: ctx,
      runId: "run1",
      justRanTaskIds: ["t1"],
      remaining: [task("t2"), task("t3")],
      dispatch: async () => decide({ action: "finish" }),
    })
    expect(out.finish).toBe(true)
    expect(out.remaining).toEqual([])
    expect(setTaskStatus).toHaveBeenCalledWith("t2", "cancelled")
    expect(setTaskStatus).toHaveBeenCalledWith("t3", "cancelled")
  })

  it("routes through the approval gate and applies an edited decision", async () => {
    const { ctx, setTaskStatus } = makeCtx({ requireApproval: true })
    const gate = jest.fn(async () => ({
      approved: true,
      decision: decide({ action: "cancel", cancelTaskIds: ["t2"] }),
    }))
    const out = await runReplanCheckpoint({
      teamCtx: ctx,
      runId: "run1",
      justRanTaskIds: [],
      remaining: [task("t2"), task("t3")],
      dispatch: async () => decide({ action: "finish" }),
      gate,
    })
    expect(gate).toHaveBeenCalled()
    // The edited decision (cancel t2) is applied, not the lead's finish.
    expect(setTaskStatus).toHaveBeenCalledWith("t2", "cancelled")
    expect(out.remaining.map((t) => t.id)).toEqual(["t3"])
  })

  it("continues unchanged when the operator rejects at the gate", async () => {
    const { ctx, setTaskStatus } = makeCtx({ requireApproval: true })
    const out = await runReplanCheckpoint({
      teamCtx: ctx,
      runId: "run1",
      justRanTaskIds: [],
      remaining: [task("t2")],
      dispatch: async () => decide({ action: "finish" }),
      gate: async () => ({ approved: false, decision: continueDecision() }),
    })
    expect(out.finish).toBe(false)
    expect(out.remaining).toHaveLength(1)
    expect(setTaskStatus).not.toHaveBeenCalled()
  })

  describe("default (non-injected) paths", () => {
    it("uses the default dispatchStructured when no dispatch is injected", async () => {
      const { ctx, setTaskStatus } = makeCtx()
      dispatchStructuredMock.mockResolvedValue({
        value: decide({ action: "cancel", cancelTaskIds: ["t2"] }),
        teammateId: "w1",
        raw: "{}",
      })
      const out = await runReplanCheckpoint({
        teamCtx: ctx,
        runId: "run1",
        justRanTaskIds: ["t1"],
        remaining: [task("t2"), task("t3")],
      })
      expect(dispatchStructuredMock).toHaveBeenCalled()
      expect(setTaskStatus).toHaveBeenCalledWith("t2", "cancelled")
      expect(out.remaining.map((t) => t.id)).toEqual(["t3"])
    })

    it("fails open to continue when the default dispatch throws", async () => {
      const { ctx } = makeCtx()
      dispatchStructuredMock.mockRejectedValue(new Error("no structured output"))
      const out = await runReplanCheckpoint({
        teamCtx: ctx,
        runId: "run1",
        justRanTaskIds: ["t1"],
        remaining: [task("t2")],
      })
      expect(out.decision.action).toBe("continue")
      expect(out.remaining).toHaveLength(1)
    })

    it("uses the default approval gate when requireApproval and no gate injected", async () => {
      const { ctx, setTaskStatus } = makeCtx({ requireApproval: true })
      dispatchStructuredMock.mockResolvedValue({
        value: decide({ action: "finish" }),
        teammateId: "w1",
        raw: "{}",
      })
      awaitReplanApprovalMock.mockResolvedValue({
        approved: true,
        decision: decide({ action: "finish" }),
      })
      const out = await runReplanCheckpoint({
        teamCtx: ctx,
        runId: "run1",
        justRanTaskIds: ["t1"],
        remaining: [task("t2"), task("t3")],
      })
      expect(awaitReplanApprovalMock).toHaveBeenCalled()
      expect(out.finish).toBe(true)
      expect(setTaskStatus).toHaveBeenCalledWith("t2", "cancelled")
    })

    it("includes captured wave results in the lead prompt", async () => {
      const { ctx } = makeCtx()
      readDependencyResultsMock.mockReturnValue([
        { taskId: "t1", taskTitle: "Research", value: "found three leads" },
      ])
      dispatchStructuredMock.mockResolvedValue({
        value: decide({ action: "continue" }),
        teammateId: "w1",
        raw: "{}",
      })
      await runReplanCheckpoint({
        teamCtx: ctx,
        runId: "run1",
        justRanTaskIds: ["t1"],
        remaining: [],
      })
      const prompt = (dispatchStructuredMock.mock.calls[0]![1] as { prompt: string }).prompt
      expect(prompt).toContain("Research: found three leads")
      // Empty remaining renders the "(none)" branch.
      expect(prompt).toContain("(none)")
    })
  })
})
