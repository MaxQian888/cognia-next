import type { AgentTeam } from "@/types/agent/agent-team"

const recover = jest.fn(async () => [{ runId: "run-1", status: "needs_input" as const }])
const retryChild = jest.fn(async () => undefined)
const runTeamLifecycle = jest.fn<
  Promise<{ runId: string; status: "failed" }>,
  [teamId: string, options: unknown]
>(async () => ({ runId: "run-1", status: "failed" }))
const settleAgentTeamExecutionRun = jest.fn<Promise<void>, unknown[]>(async () => undefined)
const emitSchedulerEvent = jest.fn<Promise<void>, unknown[]>(async () => undefined)
const listAgentTeamRuns = jest.fn<Promise<Array<{ id: string; status: string }>>, [teamId: string]>(
  async () => [{ id: "run-1", status: "running" }]
)
const getAgentTeamRun = jest.fn<
  Promise<{ id: string; teamId: string; status: "needs_input" }>,
  [runId: string]
>(async () => ({ id: "run-1", teamId: "team-1", status: "needs_input" }))
const getAgentTeamChildRun = jest.fn(async () => ({
  id: "child-1",
  runId: "run-1",
  teamId: "team-1",
  taskId: "task-1",
}))
const controlDurableRun = jest.fn<Promise<void>, [runId: string, action: string]>(
  async () => undefined
)
const setTeamStatus = jest.fn()
const updateTask = jest.fn()

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
  updateTask,
}

jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: { getState: () => storeState },
}))

jest.mock("./team/durable-runtime", () => ({
  getDurableTeamCoordinator: () => ({ recover, retryChild }),
}))

jest.mock("@/lib/db/agent-team-runtime", () => ({
  getAgentTeamRun: (runId: string) => getAgentTeamRun(runId),
  getAgentTeamChildRun: () => getAgentTeamChildRun(),
  listAgentTeamRuns: (teamId: string) => listAgentTeamRuns(teamId),
}))

jest.mock("./agent-team-runtime", () => ({
  abortTeam: jest.fn(),
  runTeamLifecycle: (teamId: string, options: unknown) => runTeamLifecycle(teamId, options),
}))

jest.mock("@/lib/execution/agent-team-bridge", () => ({
  settleAgentTeamExecutionRun: (...args: unknown[]) => settleAgentTeamExecutionRun(...args),
}))

jest.mock("@/lib/scheduler/event-integration", () => ({
  emitSchedulerEvent: (...args: unknown[]) => emitSchedulerEvent(...args),
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

  it("retries one child through the durable coordinator without terminal settlement", async () => {
    await agentTeamManager.retryChild("child-1", "device:worker-b")
    await Promise.resolve()

    expect(retryChild).toHaveBeenCalledWith("child-1", "device:worker-b")
    expect(updateTask).toHaveBeenCalledWith("task-1", {
      status: "pending",
      error: undefined,
      completedAt: undefined,
    })
    expect(runTeamLifecycle).toHaveBeenCalledWith(
      "team-1",
      expect.objectContaining({ runId: "run-1", taskFilter: expect.any(Function) })
    )
    expect(setTeamStatus).toHaveBeenLastCalledWith("team-1", "paused")
    expect(settleAgentTeamExecutionRun).not.toHaveBeenCalled()
    expect(emitSchedulerEvent).not.toHaveBeenCalled()
  })
})
