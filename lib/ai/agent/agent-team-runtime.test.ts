/**
 * Runtime tests use a fake `AgentTeamStoreLike` so we don't pull the
 * real Zustand store + nanoid + immutable update helpers. Each test
 * builds the minimum data shape it needs.
 */

import {
  abortTeam,
  parseProposedPlan,
  runTeamLifecycle,
  __resetInflightForTesting,
  type AgentTeamRuntimeDeps,
  type AgentTeamStoreLike,
  type LeadPlanResult,
  type TeammateTaskResult,
} from "./agent-team-runtime"
import {
  approve as approvePlan,
  reject as rejectPlan,
  __resetForTesting as resetBus,
} from "./plan-approval-bus"
import type {
  AgentTeam,
  AgentTeammate,
  AgentTeamTask,
  TeamExecutionReport,
} from "@/types/agent/agent-team"

// Helper: build a team store fake.
function makeFakeStore(seed: {
  team: AgentTeam
  teammates: AgentTeammate[]
  tasks: AgentTeamTask[]
}): AgentTeamStoreLike & {
  state: {
    team: AgentTeam
    teammates: Record<string, AgentTeammate>
    tasks: Record<string, AgentTeamTask>
    reports: TeamExecutionReport[]
  }
} {
  const state = {
    team: { ...seed.team },
    teammates: Object.fromEntries(seed.teammates.map((t) => [t.id, { ...t }])),
    tasks: Object.fromEntries(seed.tasks.map((t) => [t.id, { ...t }])),
    reports: [] as TeamExecutionReport[],
  }
  return {
    state,
    getTeam: (id) => (id === state.team.id ? state.team : undefined),
    getTeammate: (id) => state.teammates[id],
    getTeammates: (teamId) => Object.values(state.teammates).filter((m) => m.teamId === teamId),
    getTeamTasks: (teamId) =>
      Object.values(state.tasks)
        .filter((t) => t.teamId === teamId)
        .sort((a, b) => a.order - b.order),
    setTeamStatus: (_teamId, status) => {
      state.team.status = status
    },
    updateTeam: (_teamId, updates) => {
      state.team = { ...state.team, ...updates }
    },
    setTeammateStatus: (id, status) => {
      const m = state.teammates[id]
      if (m) state.teammates[id] = { ...m, status }
    },
    updateTeammate: (id, updates) => {
      const m = state.teammates[id]
      if (m) state.teammates[id] = { ...m, ...updates }
    },
    setTaskStatus: (id, status, result, error) => {
      const t = state.tasks[id]
      if (t) {
        state.tasks[id] = {
          ...t,
          status,
          result: result ?? t.result,
          error: error ?? t.error,
        }
      }
    },
    assignTask: (id, teammateId) => {
      const t = state.tasks[id]
      if (t) state.tasks[id] = { ...t, assignedTo: teammateId, claimedBy: teammateId }
    },
    upsertExecutionReport: (_teamId, report) => {
      state.reports.push(report)
    },
  }
}

function makeTeam(overrides: Partial<AgentTeam> = {}): AgentTeam {
  const now = new Date(2026, 0, 1)
  return {
    id: "team-1",
    name: "T",
    description: "",
    task: "do work",
    status: "idle",
    config: {
      maxTeammates: 5,
      maxConcurrentTeammates: 2,
      executionMode: "coordinated",
      displayMode: "compact",
    },
    leadId: "lead-1",
    teammateIds: ["lead-1", "tm-1", "tm-2"],
    taskIds: ["task-1", "task-2"],
    messageIds: [],
    progress: 0,
    totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    createdAt: now,
    ...overrides,
  }
}

function makeTeammate(id: string, overrides: Partial<AgentTeammate> = {}): AgentTeammate {
  const now = new Date(2026, 0, 1)
  return {
    id,
    teamId: "team-1",
    name: id,
    description: "",
    role: id === "lead-1" ? "lead" : "teammate",
    status: "idle",
    config: {},
    completedTaskIds: [],
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    progress: 0,
    createdAt: now,
    ...overrides,
  }
}

function makeTask(
  id: string,
  order: number,
  overrides: Partial<AgentTeamTask> = {}
): AgentTeamTask {
  const now = new Date(2026, 0, 1)
  return {
    id,
    teamId: "team-1",
    title: `Task ${id}`,
    description: "",
    status: "pending",
    priority: "normal",
    dependencies: [],
    tags: [],
    createdAt: now,
    order,
    ...overrides,
  }
}

beforeEach(() => {
  __resetInflightForTesting()
  resetBus()
})

describe("parseProposedPlan", () => {
  it("decodes a JSON-fenced block", () => {
    const out = parseProposedPlan('here it is\n```json\n{"steps":["a"]}\n```\n')
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.plan).toEqual({ steps: ["a"] })
  })

  it("decodes raw JSON without fences", () => {
    const out = parseProposedPlan('{"x":1}')
    expect(out.ok).toBe(true)
  })

  it("returns ok=false on empty input", () => {
    const out = parseProposedPlan("   ")
    expect(out.ok).toBe(false)
  })

  it("returns ok=false on malformed JSON", () => {
    const out = parseProposedPlan("not json at all")
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toBeDefined()
  })
})

describe("runTeamLifecycle — happy path", () => {
  it("dispatches every pending task and ends in 'completed'", async () => {
    const store = makeFakeStore({
      team: makeTeam(),
      teammates: [makeTeammate("lead-1"), makeTeammate("tm-1"), makeTeammate("tm-2")],
      tasks: [makeTask("task-1", 0), makeTask("task-2", 1)],
    })
    const runTeammateTask = jest.fn(
      async (): Promise<TeammateTaskResult> => ({
        result: "done",
        tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      })
    )
    const deps: AgentTeamRuntimeDeps = { store, runTeammateTask }
    const report = await runTeamLifecycle("team-1", deps)

    expect(report.status).toBe("completed")
    expect(report.summary?.completedTasks).toBe(2)
    expect(report.summary?.failedTasks).toBe(0)
    expect(report.summary?.totalTokens).toBe(30)
    expect(store.state.team.status).toBe("completed")
    expect(store.state.team.totalTokenUsage?.totalTokens).toBe(30)
    expect(runTeammateTask).toHaveBeenCalledTimes(2)
    // Tasks are completed.
    expect(store.state.tasks["task-1"]?.status).toBe("completed")
    expect(store.state.tasks["task-2"]?.status).toBe("completed")
  })

  it("respects maxConcurrentTeammates by serializing when capped at 1", async () => {
    const store = makeFakeStore({
      team: makeTeam({ config: { ...makeTeam().config, maxConcurrentTeammates: 1 } }),
      teammates: [makeTeammate("lead-1"), makeTeammate("tm-1"), makeTeammate("tm-2")],
      tasks: [makeTask("task-1", 0), makeTask("task-2", 1)],
    })
    const order: string[] = []
    const runTeammateTask = jest.fn(async ({ task }): Promise<TeammateTaskResult> => {
      order.push(`start-${task.id}`)
      // Yield once so the parallel branch can interleave if it wanted to.
      await Promise.resolve()
      order.push(`end-${task.id}`)
      return { result: "ok" }
    })
    await runTeamLifecycle("team-1", { store, runTeammateTask })
    // With concurrency=1, end-1 must precede start-2.
    expect(order).toEqual(["start-task-1", "end-task-1", "start-task-2", "end-task-2"])
  })

  it("aggregates per-teammate token usage", async () => {
    const store = makeFakeStore({
      team: makeTeam(),
      teammates: [makeTeammate("lead-1"), makeTeammate("tm-1"), makeTeammate("tm-2")],
      tasks: [makeTask("task-1", 0), makeTask("task-2", 1)],
    })
    const runTeammateTask = jest.fn(
      async ({ teammate }): Promise<TeammateTaskResult> => ({
        result: "ok",
        tokenUsage:
          teammate.id === "tm-1"
            ? { promptTokens: 1, completionTokens: 2, totalTokens: 3 }
            : { promptTokens: 4, completionTokens: 5, totalTokens: 9 },
      })
    )
    await runTeamLifecycle("team-1", { store, runTeammateTask })
    const tm1 = store.state.teammates["tm-1"]
    const tm2 = store.state.teammates["tm-2"]
    expect(tm1?.tokenUsage.totalTokens).toBe(3)
    expect(tm2?.tokenUsage.totalTokens).toBe(9)
  })
})

describe("runTeamLifecycle — error paths", () => {
  it("ends in 'failed' when every task fails", async () => {
    const store = makeFakeStore({
      team: makeTeam(),
      teammates: [makeTeammate("lead-1"), makeTeammate("tm-1")],
      tasks: [makeTask("task-1", 0)],
    })
    const runTeammateTask = jest.fn(
      async (): Promise<TeammateTaskResult> => ({
        result: "",
        error: "boom",
      })
    )
    const report = await runTeamLifecycle("team-1", { store, runTeammateTask })
    expect(report.status).toBe("failed")
    expect(report.summary?.failedTasks).toBe(1)
    expect(store.state.tasks["task-1"]?.error).toBe("boom")
  })

  it("ends in 'completed' when at least one task succeeds, even with one failure", async () => {
    const store = makeFakeStore({
      team: makeTeam(),
      teammates: [makeTeammate("lead-1"), makeTeammate("tm-1"), makeTeammate("tm-2")],
      tasks: [makeTask("task-1", 0), makeTask("task-2", 1)],
    })
    const runTeammateTask = jest.fn(
      async ({ task }): Promise<TeammateTaskResult> =>
        task.id === "task-1" ? { result: "ok" } : { result: "", error: "boom" }
    )
    const report = await runTeamLifecycle("team-1", { store, runTeammateTask })
    expect(report.status).toBe("completed")
    expect(report.summary?.completedTasks).toBe(1)
    expect(report.summary?.failedTasks).toBe(1)
  })

  it("propagates thrown errors as task failures rather than crashing", async () => {
    const store = makeFakeStore({
      team: makeTeam(),
      teammates: [makeTeammate("lead-1"), makeTeammate("tm-1")],
      tasks: [makeTask("task-1", 0)],
    })
    const runTeammateTask = jest.fn(async () => {
      throw new Error("network down")
    })
    const report = await runTeamLifecycle("team-1", { store, runTeammateTask })
    expect(report.status).toBe("failed")
    expect(store.state.tasks["task-1"]?.error).toBe("network down")
  })

  it("rejects when the team isn't found", async () => {
    const store = makeFakeStore({
      team: makeTeam(),
      teammates: [],
      tasks: [],
    })
    await expect(
      runTeamLifecycle("missing", { store, runTeammateTask: jest.fn() })
    ).rejects.toThrow(/not found/)
  })

  it("fails when there are no teammates to dispatch", async () => {
    const store = makeFakeStore({
      team: makeTeam({ teammateIds: ["lead-1"] }),
      teammates: [makeTeammate("lead-1")],
      tasks: [makeTask("task-1", 0)],
    })
    const report = await runTeamLifecycle("team-1", { store, runTeammateTask: jest.fn() })
    expect(report.status).toBe("failed")
    expect(store.state.team.error).toMatch(/No teammates/)
  })

  it("rejects a second concurrent run for the same team", async () => {
    const store = makeFakeStore({
      team: makeTeam(),
      teammates: [makeTeammate("lead-1"), makeTeammate("tm-1")],
      tasks: [makeTask("task-1", 0)],
    })
    const runTeammateTask = jest.fn(async (): Promise<TeammateTaskResult> => {
      // Hold the slot open across the second-call test.
      await new Promise((r) => setTimeout(r, 50))
      return { result: "ok" }
    })
    const first = runTeamLifecycle("team-1", { store, runTeammateTask })
    await expect(runTeamLifecycle("team-1", { store, runTeammateTask })).rejects.toThrow(
      /already running/
    )
    await first
  })
})

describe("runTeamLifecycle — abort / cancel", () => {
  it("aborts in-flight work via abortTeam and ends in 'cancelled'", async () => {
    const store = makeFakeStore({
      team: makeTeam(),
      teammates: [makeTeammate("lead-1"), makeTeammate("tm-1")],
      tasks: [makeTask("task-1", 0), makeTask("task-2", 1)],
    })
    const runTeammateTask = jest.fn(async ({ signal }) => {
      // Simulate a slow task that respects the abort signal.
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 200)
        signal.addEventListener("abort", () => {
          clearTimeout(timer)
          reject(signal.reason ?? new Error("aborted"))
        })
      })
      return { result: "ok" }
    })
    const promise = runTeamLifecycle("team-1", { store, runTeammateTask })
    // Give the runtime a tick to start the first task.
    await new Promise((r) => setTimeout(r, 10))
    expect(abortTeam("team-1")).toBe(true)
    const report = await promise
    expect(report.status).toBe("cancelled")
    expect(store.state.team.status).toBe("cancelled")
  })

  it("respects an externally-supplied AbortSignal", async () => {
    const store = makeFakeStore({
      team: makeTeam(),
      teammates: [makeTeammate("lead-1"), makeTeammate("tm-1")],
      tasks: [makeTask("task-1", 0)],
    })
    const ac = new AbortController()
    const runTeammateTask = jest.fn(async ({ signal }) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 200)
        signal.addEventListener("abort", () => {
          clearTimeout(timer)
          reject(new Error("aborted"))
        })
      })
      return { result: "ok" }
    })
    const promise = runTeamLifecycle("team-1", { store, runTeammateTask }, ac.signal)
    await new Promise((r) => setTimeout(r, 10))
    ac.abort()
    const report = await promise
    expect(report.status).toBe("cancelled")
  })

  it("abortTeam returns false when no run is in progress", () => {
    expect(abortTeam("never-started")).toBe(false)
  })
})

describe("runTeamLifecycle — plan-approval gate", () => {
  function setupApprovalCase(
    requirePlanApproval: boolean,
    runLeadPlanning?: AgentTeamRuntimeDeps["runLeadPlanning"]
  ) {
    const store = makeFakeStore({
      team: makeTeam({
        config: {
          ...makeTeam().config,
          requirePlanApproval,
        },
      }),
      teammates: [makeTeammate("lead-1"), makeTeammate("tm-1")],
      tasks: [makeTask("task-1", 0)],
    })
    const runTeammateTask = jest.fn(async (): Promise<TeammateTaskResult> => ({ result: "ok" }))
    return { store, runTeammateTask, runLeadPlanning }
  }

  it("dispatches without planning when requirePlanApproval=false", async () => {
    const { store, runTeammateTask } = setupApprovalCase(false)
    const report = await runTeamLifecycle("team-1", { store, runTeammateTask })
    expect(report.status).toBe("completed")
  })

  it("waits for approval, then dispatches", async () => {
    const planning = jest.fn(
      async (): Promise<LeadPlanResult> => ({
        planText: '```json\n{"steps":["a"]}\n```',
      })
    )
    const { store, runTeammateTask } = setupApprovalCase(true, planning)
    const promise = runTeamLifecycle("team-1", {
      store,
      runTeammateTask,
      runLeadPlanning: planning,
    })
    // Let planning fire.
    await new Promise((r) => setTimeout(r, 10))
    approvePlan("team-1")
    const report = await promise
    expect(report.status).toBe("completed")
    expect(planning).toHaveBeenCalledTimes(1)
    expect(runTeammateTask).toHaveBeenCalledTimes(1)
    expect(store.state.teammates["lead-1"]?.proposedPlan).toContain("steps")
  })

  it("loops on reject up to maxPlanRevisions, then fails", async () => {
    const team = makeTeam({
      config: {
        ...makeTeam().config,
        requirePlanApproval: true,
        maxPlanRevisions: 2,
      },
    })
    const store = makeFakeStore({
      team,
      teammates: [makeTeammate("lead-1"), makeTeammate("tm-1")],
      tasks: [makeTask("task-1", 0)],
    })
    const planning = jest.fn(async (): Promise<LeadPlanResult> => ({ planText: '{"x":1}' }))
    const runTeammateTask = jest.fn()
    const promise = runTeamLifecycle("team-1", {
      store,
      runTeammateTask,
      runLeadPlanning: planning,
    })
    // First revision → reject
    await new Promise((r) => setTimeout(r, 10))
    rejectPlan("team-1", "no")
    // Second revision → reject again
    await new Promise((r) => setTimeout(r, 10))
    rejectPlan("team-1", "still no")
    const report = await promise
    expect(report.status).toBe("failed")
    expect(planning).toHaveBeenCalledTimes(2)
    expect(runTeammateTask).not.toHaveBeenCalled()
    expect(store.state.team.error).toMatch(/Plan rejected/)
  })

  it("requirePlanApproval=true without runLeadPlanning ends in failed", async () => {
    const { store, runTeammateTask } = setupApprovalCase(true)
    const report = await runTeamLifecycle("team-1", { store, runTeammateTask })
    expect(report.status).toBe("failed")
    expect(store.state.team.error).toMatch(/runLeadPlanning/)
  })
})
