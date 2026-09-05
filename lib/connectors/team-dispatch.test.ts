/**
 * Tests for lib/connectors/team-dispatch.ts, the IM lane's thin wrapper over
 * `startSquadRun`. The seam's collaborators are injected so the test never
 * imports the heavy Agent-Team graph. What is pinned here is what the IM lane
 * ADDS: the trigger origin, the connector binding, the plan-approval delegate
 * and the audit vocabulary of its refusals.
 */

import {
  startTeamRunFromIM,
  resolveTeamByNameOrId,
  type StartTeamRunFromIMDeps,
} from "./team-dispatch"
import type { SquadReadiness } from "@/lib/agent-team/squad-readiness"

// Mocks for the modules the DEFAULT loaders dynamically import, so the
// fallback loader paths (and resolveTeamByNameOrId) are covered.
const runSquadLifecycleMock = jest.fn(async (_input: Record<string, unknown>) => ({
  runId: "r",
  status: "completed",
}))
jest.mock("@/lib/ai/agent/team/squad-lifecycle-runner", () => ({
  __esModule: true,
  runSquadLifecycle: (input: Record<string, unknown>) => runSquadLifecycleMock(input),
}))
const createSquadRunRecordsMock = jest.fn(async (seed: { runId: string }) => ({
  executionRunId: `execution:team:${seed.runId}`,
  created: true,
}))
jest.mock("@/lib/ai/agent/team/squad-run-records", () => ({
  __esModule: true,
  createSquadRunRecords: (seed: { runId: string }) => createSquadRunRecordsMock(seed),
  findLiveSquadRun: async () => undefined,
}))
jest.mock("@/lib/agent-team/squad-readiness", () => ({
  __esModule: true,
  evaluateSquadReadiness: async () => ({ ready: true, blockers: [], evaluatedAt: 1 }),
}))
const ensureConnectorRunBindingMock = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("@/lib/execution/agent-state-bridge", () => ({
  __esModule: true,
  ensureConnectorRunBinding: (...args: unknown[]) => ensureConnectorRunBindingMock(...args),
}))

const getTeamMock = jest.fn((id: string) =>
  id === "team_real" ? { id, name: "Real", config: {} } : undefined
)
jest.mock("@/stores/agent/agent-team-store", () => ({
  __esModule: true,
  useAgentTeamStore: {
    getState: () => ({
      getTeam: getTeamMock,
      getTeammates: () => [{ role: "teammate" }],
      getTeamTasks: () => [],
      updateTeam: jest.fn(),
      teams: { team_real: { id: "team_real", name: "Real" } },
    }),
  },
}))

const READY: SquadReadiness = { ready: true, blockers: [], evaluatedAt: 1 }

interface Harness {
  runCalls: Array<Record<string, unknown>>
  updates: Array<{ teamId: string; updates: { task?: string } }>
  bindings: unknown[]
  deps: StartTeamRunFromIMDeps
}

function harness(opts: { teamExists?: boolean; readiness?: SquadReadiness } = {}): Harness {
  const runCalls: Harness["runCalls"] = []
  const updates: Harness["updates"] = []
  const bindings: unknown[] = []
  const teamExists = opts.teamExists ?? true
  const store = {
    getTeam: (id: string) => (teamExists ? { id, name: "T", config: {} } : undefined),
    getTeammates: () => [{ role: "teammate" }],
    getTeamTasks: () => [],
    updateTeam: (teamId: string, u: { task?: string }) => updates.push({ teamId, updates: u }),
  }
  const deps: StartTeamRunFromIMDeps = {
    loadStore: async () => store,
    evaluateReadiness: async () => opts.readiness ?? READY,
    findLiveRun: async () => undefined,
    createRunRecords: async (seed) => ({
      executionRunId: `execution:team:${seed.runId}`,
      created: true,
    }),
    bindConnectorRun: async (input) => {
      bindings.push(input)
    },
    runLifecycle: async (input) => {
      runCalls.push(input as unknown as Record<string, unknown>)
      return { runId: input.runId, status: "completed" }
    },
  }
  return { runCalls, updates, bindings, deps }
}

describe("startTeamRunFromIM", () => {
  it("returns no_team_id for a blank teamId", async () => {
    const h = harness()
    const res = await startTeamRunFromIM(
      { teamId: "  ", goal: "hi", adapterId: "tg-1", conversationKey: "k" },
      h.deps
    )
    expect(res).toEqual({ started: false, reason: "no_team_id" })
    expect(h.runCalls).toHaveLength(0)
  })

  it("returns team_not_found when the store has no such team", async () => {
    const h = harness({ teamExists: false })
    const res = await startTeamRunFromIM(
      { teamId: "team_x", goal: "hi", adapterId: "tg-1", conversationKey: "k" },
      h.deps
    )
    expect(res).toEqual({ started: false, reason: "team_not_found" })
    expect(h.runCalls).toHaveLength(0)
  })

  /** The two refusals a person can act on pass through with their detail. */
  it("passes readiness blockers and an open run through instead of flattening them", async () => {
    const blocked = harness({
      readiness: {
        ready: false,
        blockers: [{ code: "missing_environment_ref", action: "configure_environment" }],
        evaluatedAt: 1,
      },
    })
    await expect(
      startTeamRunFromIM(
        { teamId: "team_x", goal: "hi", adapterId: "tg-1", conversationKey: "k" },
        blocked.deps
      )
    ).resolves.toEqual({
      started: false,
      reason: "not_ready",
      blockers: [{ code: "missing_environment_ref", action: "configure_environment" }],
    })

    const busy = harness()
    busy.deps.findLiveRun = async () => ({ id: "run_team_open" })
    await expect(
      startTeamRunFromIM(
        { teamId: "team_x", goal: "hi", adapterId: "tg-1", conversationKey: "k" },
        busy.deps
      )
    ).resolves.toEqual({ started: false, reason: "already_running", runId: "run_team_open" })
  })

  it("seeds the objective and launches the lifecycle with the IM trigger", async () => {
    const h = harness()
    const permissionCeiling = { disallowedTools: ["Bash"] }
    h.deps.loadCharacter = async () => ({
      id: "char_1",
      name: "Sage",
      systemPrompt: "Be precise",
    })
    const res = await startTeamRunFromIM(
      {
        teamId: "team_x",
        goal: "build a parser",
        adapterId: "tg-1",
        conversationKey: "telegram:tg-1:9",
        sessionId: "s1",
        characterId: "char_1",
        permissionCeiling,
      },
      h.deps
    )
    expect(res).toEqual({ started: true, runId: expect.stringMatching(/^run_team_/) })
    expect(h.updates).toEqual([{ teamId: "team_x", updates: { task: "build a parser" } }])
    await Promise.resolve()
    expect(h.runCalls).toHaveLength(1)
    expect(h.runCalls[0]).toMatchObject({
      teamId: "team_x",
      runId: res.runId,
      origin: "im",
      triggeredFrom: {
        source: "im",
        adapterId: "tg-1",
        conversationKey: "telegram:tg-1:9",
        sessionId: "s1",
        characterId: "char_1",
      },
      permissionCeiling,
      entryPersona: { id: "char_1", name: "Sage", systemPrompt: "Be precise" },
    })
  })

  it("fails closed when the bound Character was deleted", async () => {
    const h = harness()
    h.deps.loadCharacter = async () => undefined
    const res = await startTeamRunFromIM(
      {
        teamId: "team_x",
        goal: "hi",
        adapterId: "tg-1",
        conversationKey: "k",
        characterId: "missing",
      },
      h.deps
    )
    expect(res).toEqual({ started: false, reason: "dispatch_error" })
    expect(h.runCalls).toHaveLength(0)
  })

  it("does not seed when goal is blank", async () => {
    const h = harness()
    await startTeamRunFromIM(
      { teamId: "team_x", goal: "   ", adapterId: "tg-1", conversationKey: "k" },
      h.deps
    )
    expect(h.updates).toHaveLength(0)
    await Promise.resolve()
    expect(h.runCalls).toHaveLength(1)
  })

  it("returns dispatch_error when a loader throws", async () => {
    const res = await startTeamRunFromIM(
      { teamId: "team_x", goal: "hi", adapterId: "tg-1", conversationKey: "k" },
      { loadStore: async () => Promise.reject(new Error("boom")) }
    )
    expect(res).toEqual({ started: false, reason: "dispatch_error" })
  })

  it("uses the default loaders (mocked modules) to launch a run", async () => {
    runSquadLifecycleMock.mockClear()
    const res = await startTeamRunFromIM({
      teamId: "team_real",
      goal: "go",
      adapterId: "tg-1",
      conversationKey: "telegram:tg-1:1",
    })
    expect(res).toEqual({ started: true, runId: expect.stringMatching(/^run_team_/) })
    await new Promise((r) => setTimeout(r, 0))
    expect(runSquadLifecycleMock).toHaveBeenCalledTimes(1)
  })
})

describe("resolveTeamByNameOrId", () => {
  it("resolves by exact id", async () => {
    await expect(resolveTeamByNameOrId("team_real")).resolves.toEqual({
      id: "team_real",
      name: "Real",
    })
  })

  it("resolves by case-insensitive name", async () => {
    await expect(resolveTeamByNameOrId("real")).resolves.toEqual({
      id: "team_real",
      name: "Real",
    })
  })

  it("returns undefined for an unknown team", async () => {
    await expect(resolveTeamByNameOrId("ghost")).resolves.toBeUndefined()
  })
})

describe("execution run binding", () => {
  const session = {
    id: "s1",
    platformBinding: { adapterId: "a1", conversationKey: "telegram:a1:c1" },
  } as never

  beforeEach(() => {
    ensureConnectorRunBindingMock.mockClear()
    createSquadRunRecordsMock.mockClear()
  })

  it("creates the run records and the conversation binding before firing the lifecycle", async () => {
    const order: string[] = []
    createSquadRunRecordsMock.mockImplementationOnce(async (seed) => {
      order.push("records")
      return { executionRunId: `execution:team:${seed.runId}`, created: true }
    })
    ensureConnectorRunBindingMock.mockImplementationOnce(async () => {
      order.push("binding")
    })
    runSquadLifecycleMock.mockImplementationOnce(async () => {
      order.push("run")
      return { runId: "r", status: "completed" }
    })
    const result = await startTeamRunFromIM({
      teamId: "team_real",
      goal: "Ship the thing",
      adapterId: "a1",
      conversationKey: "telegram:a1:c1",
      sessionId: "s1",
      session,
    })

    expect(result.started).toBe(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(order).toEqual(["records", "binding", "run"])
    expect(createSquadRunRecordsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: result.runId,
        objective: "Ship the thing",
        sessionId: "s1",
        origin: "im",
      })
    )
    expect(ensureConnectorRunBindingMock).toHaveBeenCalledWith(
      `execution:team:${result.runId}`,
      undefined,
      session
    )
  })

  it("still dispatches when no session is available, just uncarded", async () => {
    const result = await startTeamRunFromIM({
      teamId: "team_real",
      goal: "Ship the thing",
      adapterId: "a1",
      conversationKey: "telegram:a1:c1",
    })
    expect(result.started).toBe(true)
    expect(ensureConnectorRunBindingMock).not.toHaveBeenCalled()
  })

  it("never lets a binding failure reject the dispatch", async () => {
    ensureConnectorRunBindingMock.mockRejectedValueOnce(new Error("dexie down"))
    const result = await startTeamRunFromIM({
      teamId: "team_real",
      goal: "Ship the thing",
      adapterId: "a1",
      conversationKey: "telegram:a1:c1",
      session,
    })
    expect(result.started).toBe(true)
  })

  /** Fail closed: no records, no run. */
  it("refuses the dispatch when the records cannot be written", async () => {
    createSquadRunRecordsMock.mockRejectedValueOnce(new Error("quota"))
    runSquadLifecycleMock.mockClear()
    const result = await startTeamRunFromIM({
      teamId: "team_real",
      goal: "Ship the thing",
      adapterId: "a1",
      conversationKey: "telegram:a1:c1",
      session,
    })
    expect(result).toEqual({ started: false, reason: "dispatch_error" })
    await new Promise((r) => setTimeout(r, 0))
    expect(runSquadLifecycleMock).not.toHaveBeenCalled()
  })
})

describe("plan approval channel", () => {
  const withTarget = {
    id: "s1",
    platformBinding: {
      adapterId: "a1",
      conversationKey: "telegram:a1:c1",
      deliveryTarget: {
        conversationRef: { platform: "telegram", adapterId: "a1", channelId: "c1" },
        address: { scopeKind: "private" },
      },
    },
  } as never

  const withoutTarget = {
    id: "s1",
    platformBinding: { adapterId: "a1", conversationKey: "telegram:a1:c1" },
  } as never

  beforeEach(() => runSquadLifecycleMock.mockClear())

  it("hands the lifecycle a way to ask when there is a surface to ask on", async () => {
    await startTeamRunFromIM({
      teamId: "team_real",
      goal: "Ship the thing",
      adapterId: "a1",
      conversationKey: "telegram:a1:c1",
      session: withTarget,
      initiatorUserId: "ou-user",
    })
    await new Promise((r) => setTimeout(r, 0))
    const input = runSquadLifecycleMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(typeof input.planApprovalDelegate).toBe("function")
    expect(input.origin).toBe("im")
  })

  it("omits the delegate when there is genuinely no surface, keeping fail-fast", async () => {
    await startTeamRunFromIM({
      teamId: "team_real",
      goal: "Ship the thing",
      adapterId: "a1",
      conversationKey: "telegram:a1:c1",
      session: withoutTarget,
    })
    await new Promise((r) => setTimeout(r, 0))
    const input = runSquadLifecycleMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(input).not.toHaveProperty("planApprovalDelegate")
  })

  it("passes the autonomy-derived approval floor through, and only when set", async () => {
    await startTeamRunFromIM({
      teamId: "team_real",
      goal: "Ship the thing",
      adapterId: "a1",
      conversationKey: "telegram:a1:c1",
      session: withTarget,
      requirePlanApprovalFloor: true,
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(runSquadLifecycleMock.mock.calls[0]?.[0]).toMatchObject({
      requirePlanApprovalFloor: true,
    })

    runSquadLifecycleMock.mockClear()
    await startTeamRunFromIM({
      teamId: "team_real",
      goal: "Ship the thing",
      adapterId: "a1",
      conversationKey: "telegram:a1:c1",
      session: withTarget,
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(runSquadLifecycleMock.mock.calls[0]?.[0]).not.toHaveProperty("requirePlanApprovalFloor")
  })
})
