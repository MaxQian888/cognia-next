import {
  agentTeamManager,
  configureAgentTeamRuntime,
  __resetAgentTeamRuntimeForTesting,
} from "./agent-team"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { __resetInflightForTesting } from "./agent-team-runtime"
import type { AgentTeam } from "@/types/agent/agent-team"

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
  // Reset the store + runtime state between tests.
  useAgentTeamStore.getState().reset()
  __resetAgentTeamRuntimeForTesting()
  __resetInflightForTesting()
})

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

  it("start() throws when the runtime hasn't been configured", async () => {
    agentTeamManager.create(makeTeam())
    await expect(agentTeamManager.start("t1")).rejects.toThrow(/not configured/)
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
    configureAgentTeamRuntime({
      runTeammateTask: jest.fn(async () => ({ result: "ok" })),
    })
    await agentTeamManager.start("t1")
    // Empty task queue → runtime resolves and team is "completed".
    expect(useAgentTeamStore.getState().teams["t1"]?.status).toBe("completed")
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
