import type { AgentTeam } from "@/types/agent/agent-team"

const recover = jest.fn(async () => [{ runId: "run-1", status: "needs_input" as const }])
const retryChild = jest.fn(async () => undefined)
const runSquadLifecycle = jest.fn<Promise<{ runId: string; status: "failed" }>, [unknown]>(
  async () => ({ runId: "run-1", status: "failed" })
)
const prepareSquadResume = jest.fn(async () => ({ remaining: 1 }))
const controlSquadTeam = jest.fn(async (_teamId: string, _action: string) => ({
  ok: true,
  status: "paused",
}))
const getAgentTeamRun = jest.fn(async () => ({
  id: "run-1",
  teamId: "team-1",
  status: "needs_input" as const,
}))
const getAgentTeamChildRun = jest.fn(async () => ({
  id: "child-1",
  runId: "run-1",
  teamId: "team-1",
  taskId: "task-1",
}))
const setTeamStatus = jest.fn()
const updateTask = jest.fn()

const team = { id: "team-1", status: "executing", config: {} } as AgentTeam

const storeState = {
  teams: { "team-1": team },
  tasks: {},
  teammates: {},
  getTeam: (id: string) => (id === team.id ? team : undefined),
  setTeamStatus,
  updateTask,
}

jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: { getState: () => storeState },
}))

jest.mock("./team/durable-runtime", () => ({
  getDurableTeamCoordinator: () => ({ recover, retryChild }),
}))

jest.mock("@/lib/db/agent-team-runtime", () => ({
  getAgentTeamRun: () => getAgentTeamRun(),
  getAgentTeamChildRun: () => getAgentTeamChildRun(),
}))

jest.mock("./team/squad-lifecycle-runner", () => ({
  runSquadLifecycle: (input: unknown) => runSquadLifecycle(input),
  prepareSquadResume: () => prepareSquadResume(),
  resumeTaskFilter: () => true,
  configureAgentTeamRuntime: jest.fn(),
  __resetAgentTeamRuntimeForTesting: jest.fn(),
}))

jest.mock("./team/squad-control", () => ({
  controlSquadTeam: (teamId: string, action: string) => controlSquadTeam(teamId, action),
}))

import { agentTeamManager, recoverDurableAgentTeams } from "./agent-team"

describe("durable AgentTeam manager", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("projects uncertain recovery as an operator input gate without replaying work", async () => {
    await expect(recoverDurableAgentTeams()).resolves.toEqual([
      { runId: "run-1", status: "needs_input" },
    ])
    expect(setTeamStatus).toHaveBeenCalledWith("team-1", "paused")
    expect(runSquadLifecycle).not.toHaveBeenCalled()
  })

  it("re-enters a safely recoverable run over its remaining work", async () => {
    recover.mockResolvedValueOnce([{ runId: "run-1", status: "recovering" as never }])
    await recoverDurableAgentTeams()
    expect(prepareSquadResume).toHaveBeenCalledTimes(1)
    expect(runSquadLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: "team-1",
        runId: "run-1",
        taskFilter: expect.any(Function),
      })
    )
  })

  /** Team-addressed verbs are adapters onto the one control state machine. */
  it.each([
    ["pause", "pause"],
    ["resume", "resume"],
    ["shutdown", "stop"],
  ] as const)("routes %s through controlSquadTeam as %s", async (verb, action) => {
    await agentTeamManager[verb]("team-1")
    expect(controlSquadTeam).toHaveBeenCalledWith("team-1", action)
  })

  it("retries one child through the durable coordinator and re-enters only that task", async () => {
    await agentTeamManager.retryChild("child-1", "device:worker-b")

    expect(retryChild).toHaveBeenCalledWith("child-1", "device:worker-b")
    expect(updateTask).toHaveBeenCalledWith("task-1", {
      status: "pending",
      error: undefined,
      completedAt: undefined,
    })
    const input = runSquadLifecycle.mock.calls[0]?.[0] as {
      teamId: string
      runId: string
      taskFilter: (task: { id: string }) => boolean
    }
    expect(input).toMatchObject({ teamId: "team-1", runId: "run-1" })
    expect(input.taskFilter({ id: "task-1" })).toBe(true)
    expect(input.taskFilter({ id: "task-2" })).toBe(false)
  })
})
