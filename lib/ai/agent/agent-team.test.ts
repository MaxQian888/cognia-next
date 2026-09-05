/**
 * The team-addressed facade. Definition CRUD proxies the store. Every runtime
 * verb is an adapter onto the two seams ADR-0169 leaves: `startSquadRun` and
 * `controlSquadTeam`. Both are mocked here so the facade's own contract is
 * what is pinned.
 */

const startSquadRun = jest.fn()
jest.mock("./team/start-squad-run", () => ({
  startSquadRun: (...args: unknown[]) => startSquadRun(...args),
}))
const controlSquadTeam = jest.fn(async (_teamId: string, _action: string) => ({ ok: true }))
jest.mock("./team/squad-control", () => ({
  controlSquadTeam: (teamId: string, action: string) => controlSquadTeam(teamId, action),
}))
const awaitSquadRunSettlement = jest.fn(async (_executionRunId: string) => "completed")
jest.mock("./team/watch-squad-run", () => ({
  awaitSquadRunSettlement: (id: string) => awaitSquadRunSettlement(id),
}))

import { agentTeamManager } from "./agent-team"
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

  it("delete() removes the team from the store", () => {
    agentTeamManager.create(makeTeam())
    agentTeamManager.delete("t1")
    expect(useAgentTeamStore.getState().teams.t1).toBeUndefined()
  })
})

describe("agentTeamManager.start", () => {
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
