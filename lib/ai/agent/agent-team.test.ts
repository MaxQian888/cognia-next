import {
  agentTeamManager,
  configureAgentTeamRuntime,
  __resetAgentTeamRuntimeForTesting,
} from "./agent-team"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { __resetInflightForTesting, runTeamLifecycle } from "./agent-team-runtime"
import type { AgentTeam, AgentTeammate, AgentTeamTask } from "@/types/agent/agent-team"

// Wrap runTeamLifecycle in a pass-through jest.fn so the resume() tests can
// stub a single run without faking the whole runtime module (the start()
// tests keep exercising the real lifecycle).
jest.mock("./agent-team-runtime", () => {
  const actual = jest.requireActual("./agent-team-runtime")
  return { ...actual, runTeamLifecycle: jest.fn(actual.runTeamLifecycle) }
})
const runTeamLifecycleMock = runTeamLifecycle as jest.Mock

function makeTeam(overrides: Partial<AgentTeam> = {}): AgentTeam {
  const now = new Date(2026, 0, 1)
  return {
    id: "t1",
    name: "Team",
    description: "",
    task: "do",
    status: "idle",
    config: {
      maxTeammates: 5,
      maxConcurrentTeammates: 1,
      executionMode: "coordinated",
      displayMode: "compact",
    },
    leadId: "lead-1",
    teammateIds: ["lead-1"],
    taskIds: [],
    messageIds: [],
    progress: 0,
    totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    createdAt: now,
    ...overrides,
  }
}

beforeEach(() => {
  // Reset the store + runtime state between tests. mockClear (not mockReset)
  // keeps the pass-through implementation installed by the module mock.
  useAgentTeamStore.getState().reset()
  __resetAgentTeamRuntimeForTesting()
  __resetInflightForTesting()
  runTeamLifecycleMock.mockClear()
})

function makeTeammate(id: string, overrides: Partial<AgentTeammate> = {}): AgentTeammate {
  return {
    id,
    teamId: "t1",
    name: id,
    description: "",
    role: "teammate",
    status: "idle",
    config: {},
    completedTaskIds: [],
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    progress: 0,
    createdAt: new Date(),
    ...overrides,
  }
}

function makeTask(id: string, overrides: Partial<AgentTeamTask> = {}): AgentTeamTask {
  return {
    id,
    teamId: "t1",
    title: id,
    description: "",
    status: "pending",
    priority: "normal",
    dependencies: [],
    tags: [],
    createdAt: new Date(),
    order: 0,
    ...overrides,
  }
}

describe("agentTeamManager (real facade)", () => {
  it("create() upserts the team into the store and returns it", () => {
    const team = makeTeam()
    const out = agentTeamManager.create(team)
    expect(out).toBe(team)
    expect(useAgentTeamStore.getState().teams["t1"]).toBeDefined()
  })

  it("list() returns every team in the store", () => {
    agentTeamManager.create(makeTeam({ id: "a" }))
    agentTeamManager.create(makeTeam({ id: "b" }))
    const list = agentTeamManager.list()
    expect(list.map((t) => t.id).sort()).toEqual(["a", "b"])
  })

  it("get() returns undefined for unknown ids", () => {
    expect(agentTeamManager.get("missing")).toBeUndefined()
  })

  it("get() returns the live team for known ids", () => {
    agentTeamManager.create(makeTeam())
    expect(agentTeamManager.get("t1")?.name).toBe("Team")
  })

  it("update() applies a partial patch to the stored team", () => {
    agentTeamManager.create(makeTeam())
    agentTeamManager.update("t1", { name: "Renamed" })
    expect(useAgentTeamStore.getState().teams["t1"]?.name).toBe("Renamed")
  })

  it("delete() removes the team from the store", () => {
    agentTeamManager.create(makeTeam())
    agentTeamManager.delete("t1")
    expect(useAgentTeamStore.getState().teams["t1"]).toBeUndefined()
  })

  it("start() auto-configures default deps (with a warning) when unconfigured", async () => {
    // No configureAgentTeamRuntime() call — start() must self-heal via the
    // lazy default deps instead of throwing. Empty task list → status=failed.
    const team = makeTeam()
    agentTeamManager.create(team)
    useAgentTeamStore.getState().upsertTeammate({
      id: "lead-1",
      teamId: "t1",
      name: "Lead",
      description: "",
      role: "lead",
      status: "idle",
      config: {},
      completedTaskIds: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      progress: 0,
      createdAt: new Date(),
    })
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    await expect(agentTeamManager.start("t1")).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("auto-configured with defaults"))
    expect(useAgentTeamStore.getState().teams["t1"]?.status).toBe("failed")
    warn.mockRestore()
  })

  it("start() uses the explicit deps and does not warn when configured", async () => {
    agentTeamManager.create(makeTeam())
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    configureAgentTeamRuntime({})
    await agentTeamManager.start("t1")
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("auto-configured with defaults"))
    warn.mockRestore()
  })

  it("start() runs the lifecycle when configured (empty task list completes immediately)", async () => {
    // Tiny team: no pending tasks → runtime resolves quickly.
    // Add a single teammate so dispatch has a worker.
    const team = makeTeam()
    agentTeamManager.create(team)
    useAgentTeamStore.getState().upsertTeammate({
      id: "lead-1",
      teamId: "t1",
      name: "Lead",
      description: "",
      role: "lead",
      status: "idle",
      config: {},
      completedTaskIds: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      progress: 0,
      createdAt: new Date(),
    })
    useAgentTeamStore.getState().upsertTeammate({
      id: "tm-1",
      teamId: "t1",
      name: "TM",
      description: "",
      role: "teammate",
      status: "idle",
      config: {},
      completedTaskIds: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      progress: 0,
      createdAt: new Date(),
    })
    configureAgentTeamRuntime({})
    await agentTeamManager.start("t1")
    // Empty task queue → F-path synthesizer returns status=failed (no tasks
    // to dispatch). The facade mirrors result.status onto the team row.
    expect(useAgentTeamStore.getState().teams["t1"]?.status).toBe("failed")
  })

  it("pause() marks the team as paused", async () => {
    agentTeamManager.create(makeTeam())
    await agentTeamManager.pause("t1")
    expect(useAgentTeamStore.getState().teams["t1"]?.status).toBe("paused")
  })

  it("shutdown() marks the team as cancelled", async () => {
    agentTeamManager.create(makeTeam())
    await agentTeamManager.shutdown("t1")
    expect(useAgentTeamStore.getState().teams["t1"]?.status).toBe("cancelled")
  })
})

describe("agentTeamManager.resume", () => {
  it("is a no-op unless the team is paused", async () => {
    agentTeamManager.create(makeTeam({ status: "idle" }))
    await agentTeamManager.resume("t1")
    expect(useAgentTeamStore.getState().teams["t1"]?.status).toBe("idle")
    expect(runTeamLifecycleMock).not.toHaveBeenCalled()

    await agentTeamManager.resume("missing")
    expect(runTeamLifecycleMock).not.toHaveBeenCalled()
  })

  it("completes immediately when nothing runnable remains, seeding the blackboard", async () => {
    agentTeamManager.create(makeTeam({ status: "paused" }))
    useAgentTeamStore.getState().upsertTeammate(makeTeammate("w1"))
    useAgentTeamStore
      .getState()
      .upsertTask(
        makeTask("done-1", { status: "completed", result: "the answer", claimedBy: "w1" })
      )
    useAgentTeamStore.getState().upsertTask(makeTask("dropped", { status: "cancelled" }))

    await agentTeamManager.resume("t1")

    expect(runTeamLifecycleMock).not.toHaveBeenCalled()
    expect(useAgentTeamStore.getState().teams["t1"]?.status).toBe("completed")
    // Persisted result re-published under the canonical blackboard key.
    const entry = useAgentTeamStore.getState().sharedMemory["t1"]?.["task:done-1"]
    expect(entry?.value).toBe("the answer")
  })

  it("unstrands mid-flight tasks/teammates and re-enters the lifecycle over remaining work only", async () => {
    agentTeamManager.create(makeTeam({ status: "paused" }))
    useAgentTeamStore
      .getState()
      .upsertTeammate(makeTeammate("w1", { status: "executing", currentTaskId: "stranded" }))
    useAgentTeamStore.getState().upsertTask(
      makeTask("stranded", {
        status: "in_progress",
        claimedBy: "w1",
        startedAt: new Date(),
      })
    )
    useAgentTeamStore
      .getState()
      .upsertTask(makeTask("done-1", { status: "completed", result: "prior" }))
    useAgentTeamStore.getState().upsertTask(makeTask("in-review", { status: "review" }))

    runTeamLifecycleMock.mockResolvedValueOnce({ runId: "run_x", status: "completed" })
    await agentTeamManager.resume("t1")

    // Reset pass ran before the lifecycle.
    const state = useAgentTeamStore.getState()
    expect(runTeamLifecycleMock).toHaveBeenCalledTimes(1)
    expect(state.tasks["stranded"].status).toBe("pending")
    expect(state.tasks["stranded"].claimedBy).toBeUndefined()
    expect(state.tasks["stranded"].startedAt).toBeUndefined()
    expect(state.teammates["w1"].status).toBe("idle")
    expect(state.teammates["w1"].currentTaskId).toBeUndefined()

    // The lifecycle received a taskFilter that keeps pending work and skips
    // completed/cancelled/review.
    const deps = runTeamLifecycleMock.mock.calls[0][1]
    expect(typeof deps.taskFilter).toBe("function")
    expect(deps.taskFilter(state.tasks["stranded"])).toBe(true)
    expect(deps.taskFilter(state.tasks["done-1"])).toBe(false)
    expect(deps.taskFilter(state.tasks["in-review"])).toBe(false)

    // Terminal status mirrored from the run result.
    expect(state.teams["t1"]?.status).toBe("completed")
  })
})
