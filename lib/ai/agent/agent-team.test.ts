/**
 * The team-addressed facade. Definition CRUD proxies the store. Every runtime
 * verb is an adapter onto the two seams ADR-0169 leaves: `startSquadRun` and
 * `controlSquadTeam`. Both are mocked here so the facade's own contract is
 * what is pinned.
 */

const purgeAgentTeam = jest.fn(async (_teamId: string) => {})
const getAgentTeamRun = jest.fn()
jest.mock("@/lib/db/agent-team-runtime", () => ({
  purgeAgentTeam: (id: string) => purgeAgentTeam(id),
  getAgentTeamRun: (id: string) => getAgentTeamRun(id),
}))
const recover = jest.fn()
jest.mock("./team/durable-runtime", () => ({ getDurableTeamCoordinator: () => ({ recover }) }))
const recoveryLifecycle = jest.fn()
const restoreSquadRunInput = jest.fn()
const parkSquadRecovery = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("./team/squad-lifecycle-runner", () => ({
  configureAgentTeamRuntime: jest.fn(),
  __resetAgentTeamRuntimeForTesting: jest.fn(),
  guardSquadResume: async () => ({ blocked: false }),
  prepareSquadResume: async () => ({ remaining: 1 }),
  resumeTaskFilter: () => true,
  runSquadLifecycle: (...args: unknown[]) => recoveryLifecycle(...args),
  restoreSquadRunInput: (...args: unknown[]) => restoreSquadRunInput(...args),
  parkSquadRecovery: (...args: unknown[]) => parkSquadRecovery(...args),
}))

const startSquadRun = jest.fn()
jest.mock("./team/start-squad-run", () => ({
  startSquadRun: (...args: unknown[]) => startSquadRun(...args),
}))
const controlSquadTeam = jest.fn(async (_teamId: string, _action: string) => ({ ok: true }))
const controlSquadRun = jest.fn(async (_runId: string, _action: string) => ({ ok: true }))
jest.mock("./team/squad-control", () => ({
  controlSquadTeam: (teamId: string, action: string) => controlSquadTeam(teamId, action),
  controlSquadRun: (runId: string, action: string) => controlSquadRun(runId, action),
}))
const awaitSquadRunSettlement = jest.fn(
  async (_executionRunId: string, _options?: { signal?: AbortSignal }) => "completed"
)
jest.mock("./team/watch-squad-run", () => ({
  awaitSquadRunSettlement: (...args: Parameters<typeof awaitSquadRunSettlement>) =>
    awaitSquadRunSettlement(...args),
}))

import { agentTeamManager, recoverDurableAgentTeams } from "./agent-team"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
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
  useAgentTeamStore.getState().reset()
  startSquadRun.mockReset()
  controlSquadTeam.mockClear()
  controlSquadRun.mockClear()
  awaitSquadRunSettlement.mockClear()
  startSquadRun.mockResolvedValue({
    started: true,
    runId: "run_team_1",
    executionRunId: "execution:team:run_team_1",
  })
})

describe("agentTeamManager (definition CRUD)", () => {
  it("create() upserts the team into the store and returns it", () => {
    const team = makeTeam()
    const created = agentTeamManager.create(team)
    expect(created).toBe(team)
    expect(useAgentTeamStore.getState().teams.t1).toEqual(team)
  })

  it("list() returns every team in the store", () => {
    agentTeamManager.create(makeTeam({ id: "a" }))
    agentTeamManager.create(makeTeam({ id: "b" }))
    expect(
      agentTeamManager
        .list()
        .map((t) => t.id)
        .sort()
    ).toEqual(["a", "b"])
  })

  it("get() returns undefined for unknown ids and the live team for known ones", () => {
    expect(agentTeamManager.get("nope")).toBeUndefined()
    agentTeamManager.create(makeTeam())
    expect(agentTeamManager.get("t1")?.id).toBe("t1")
  })

  it("update() applies a partial patch to the stored team", () => {
    agentTeamManager.create(makeTeam())
    agentTeamManager.update("t1", { name: "Renamed" })
    expect(useAgentTeamStore.getState().teams.t1?.name).toBe("Renamed")
  })

  it("delete() removes the team from the store", async () => {
    agentTeamManager.create(makeTeam())
    await agentTeamManager.delete("t1")
    expect(useAgentTeamStore.getState().teams.t1).toBeUndefined()
  })
})

describe("agentTeamManager.start", () => {
  it("passes the stable run id and cancels that exact run when its caller aborts", async () => {
    const controller = new AbortController()
    awaitSquadRunSettlement.mockImplementationOnce(async (_id, options) => {
      controller.abort(new Error("caller stopped"))
      options?.signal?.throwIfAborted()
      return "completed"
    })
    await expect(
      agentTeamManager.start("t1", { runId: "stable", signal: controller.signal })
    ).rejects.toThrow("caller stopped")
    expect(startSquadRun).toHaveBeenCalledWith(expect.objectContaining({ runId: "stable" }))
    expect(controlSquadRun).toHaveBeenCalledWith("run_team_1", "stop")
  })
  it("launches through startSquadRun and waits for the run to settle", async () => {
    const result = await agentTeamManager.start("t1", { origin: "scheduler", ultracode: true })
    expect(startSquadRun).toHaveBeenCalledWith(
      expect.objectContaining({
        squadId: "t1",
        origin: "scheduler",
        triggeredFrom: { source: "ui" },
        ultracode: true,
      })
    )
    expect(awaitSquadRunSettlement).toHaveBeenCalledWith("execution:team:run_team_1")
    expect(result).toMatchObject({ started: true, runId: "run_team_1" })
  })

  it("maps an IM origin onto an IM trigger and names the conversation", async () => {
    await agentTeamManager.start("t1", { origin: "im", sessionId: "s-9" })
    expect(startSquadRun).toHaveBeenCalledWith(
      expect.objectContaining({ triggeredFrom: { source: "im" }, session: { id: "s-9" } })
    )
  })

  it("returns without waiting when detached", async () => {
    await agentTeamManager.start("t1", { detached: true })
    expect(awaitSquadRunSettlement).not.toHaveBeenCalled()
  })

  it("does not wait on a replayed start", async () => {
    startSquadRun.mockResolvedValueOnce({
      started: true,
      runId: "run_team_1",
      executionRunId: "execution:team:run_team_1",
      duplicate: true,
    })
    await agentTeamManager.start("t1")
    expect(awaitSquadRunSettlement).not.toHaveBeenCalled()
  })

  /** A scheduler or plugin caller reports the real reason, not "unknown". */
  it("rejects with the seam's refusal, naming readiness blockers", async () => {
    startSquadRun.mockResolvedValueOnce({
      started: false,
      reason: "not_ready",
      blockers: [{ code: "missing_environment_ref" }, { code: "no_teammates" }],
    })
    await expect(agentTeamManager.start("t1")).rejects.toThrow(
      "Squad run refused: not_ready:missing_environment_ref,no_teammates"
    )
    startSquadRun.mockResolvedValueOnce({ started: false, reason: "already_running" })
    await expect(agentTeamManager.start("t1")).rejects.toThrow("Squad run refused: already_running")
  })
})

describe("recoverDurableAgentTeams", () => {
  it("finishes recovery admission without awaiting a long recovered lifecycle", async () => {
    agentTeamManager.create(makeTeam())
    getAgentTeamRun.mockResolvedValue({ id: "run-1", teamId: "t1" })
    recover.mockResolvedValue([{ runId: "run-1", status: "recovering" }])
    restoreSquadRunInput.mockResolvedValue({
      teamId: "t1",
      runId: "run-1",
      requirePlanApprovalFloor: true,
    })
    recoveryLifecycle.mockReturnValue(new Promise(() => {}))
    const result = await Promise.race([
      recoverDurableAgentTeams(),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 100)),
    ])
    expect(result).toEqual([{ runId: "run-1", status: "recovering" }])
    expect(recoveryLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ requirePlanApprovalFloor: true })
    )
  })
})

describe("agentTeamManager control verbs", () => {
  it.each([
    ["pause", "pause"],
    ["resume", "resume"],
    ["shutdown", "stop"],
  ] as const)(
    "%s addresses the team's live run through controlSquadTeam(%s)",
    async (verb, action) => {
      const result = await agentTeamManager[verb]("t1")
      expect(controlSquadTeam).toHaveBeenCalledWith("t1", action)
      expect(result).toEqual({ ok: true })
    }
  )
})
