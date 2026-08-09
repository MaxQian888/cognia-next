import type { AgentTeam } from "@/types/agent/agent-team"

const recover = jest.fn(async () => [{ runId: "run-1", status: "needs_input" as const }])
const listAgentTeamRuns = jest.fn<Promise<Array<{ id: string; status: string }>>, [teamId: string]>(
  async () => [{ id: "run-1", status: "running" }]
)
const getAgentTeamRun = jest.fn<Promise<{ id: string; teamId: string }>, [runId: string]>(
  async () => ({ id: "run-1", teamId: "team-1" })
)
const controlDurableRun = jest.fn<Promise<void>, [runId: string, action: string]>(
  async () => undefined
)
const setTeamStatus = jest.fn()

const team = {
  id: "team-1",
  status: "executing",
  config: { runtimeVersion: "durable-v2" },
} as AgentTeam

const storeState = {
  teams: { "team-1": team },
  tasks: {},
  teammates: {},
  getTeam: (id: string) => (id === team.id ? team : undefined),
  setTeamStatus,
}

jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: { getState: () => storeState },
}))

jest.mock("./team/durable-runtime", () => ({
  getDurableTeamCoordinator: () => ({ recover }),
}))

jest.mock("@/lib/db/agent-team-runtime", () => ({
  getAgentTeamRun: (runId: string) => getAgentTeamRun(runId),
  listAgentTeamRuns: (teamId: string) => listAgentTeamRuns(teamId),
}))

jest.mock("./team/durable-control", () => ({
  controlDurableRun: (runId: string, action: string) => controlDurableRun(runId, action),
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
  })

  it("routes durable pause through the persisted run control service", async () => {
    await agentTeamManager.pause("team-1")

    expect(listAgentTeamRuns).toHaveBeenCalledWith("team-1")
    expect(controlDurableRun).toHaveBeenCalledWith("run-1", "pause")
    expect(setTeamStatus).toHaveBeenCalledWith("team-1", "paused")
  })
})
