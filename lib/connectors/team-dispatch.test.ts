/**
 * Tests for lib/connectors/team-dispatch.ts — IM → Agent Team dispatch.
 * The team runtime / store / deps loaders are injected so the test never
 * imports the heavy Agent-Team graph.
 */

import {
  startTeamRunFromIM,
  resolveTeamByNameOrId,
  type StartTeamRunFromIMDeps,
} from "./team-dispatch"

// Mocks for the modules the DEFAULT loaders dynamically import, so the
// fallback loader paths (and resolveTeamByNameOrId) are covered.
const runTeamLifecycleMock = jest.fn(async (_teamId: string, deps: Record<string, unknown>) => {
  // Exercise the storeReader/storeWriter wrappers the dispatcher built so
  // those inner functions are covered (the real runtime calls them).
  const reader = deps.storeReader as {
    getTeam: (id: string) => unknown
    getTeammates: (id: string) => unknown
    getTeamTasks: (id: string) => unknown
  }
  const writer = deps.storeWriter as {
    addMessage: (m: unknown) => unknown
    setTaskStatus: (t: string, s: unknown, r?: string, e?: string) => unknown
    updateTeammate: (id: string, u: unknown) => unknown
  }
  reader.getTeam("team_real")
  reader.getTeammates("team_real")
  reader.getTeamTasks("team_real")
  writer.addMessage({})
  writer.setTaskStatus("t", "done", "ok", undefined)
  writer.updateTeammate("m", {})
  return { runId: "r", status: "completed" }
})
const ensureImTeamExecutionRunMock = jest.fn(async (_input: unknown) => "execution:team:stub")
jest.mock("@/lib/execution/agent-team-bridge", () => ({
  ensureImTeamExecutionRun: (input: unknown) => ensureImTeamExecutionRunMock(input),
  agentTeamExecutionRunId: (id: string) => `execution:team:${id}`,
}))

const getTeamMock = jest.fn((id: string) => (id === "team_real" ? { id, name: "Real" } : undefined))
jest.mock("@/stores/agent/agent-team-store", () => ({
  __esModule: true,
  useAgentTeamStore: {
    getState: () => ({
      getTeam: getTeamMock,
      getTeammates: () => [],
      getTeamTasks: () => [],
      updateTeam: jest.fn(),
      addMessage: jest.fn(),
      setTaskStatus: jest.fn(),
      updateTeammate: jest.fn(),
      teams: { team_real: { id: "team_real", name: "Real" } },
    }),
  },
}))
jest.mock("@/lib/ai/agent/agent-team-runtime", () => ({
  __esModule: true,
  runTeamLifecycle: (...args: unknown[]) =>
    runTeamLifecycleMock(...(args as Parameters<typeof runTeamLifecycleMock>)),
}))
jest.mock("@/lib/ai/agent/agent-team-runtime-deps", () => ({
  __esModule: true,
  buildAgentTeamRuntimeDeps: () => ({ notifierDeps: {} }),
}))

interface Harness {
  runCalls: Array<{ teamId: string; deps: Record<string, unknown> }>
  updates: Array<{ teamId: string; updates: { task?: string } }>
  deps: StartTeamRunFromIMDeps
}

function harness(opts: { teamExists?: boolean } = {}): Harness {
  const runCalls: Harness["runCalls"] = []
  const updates: Harness["updates"] = []
  const teamExists = opts.teamExists ?? true
  const store = {
    getTeam: (id: string) => (teamExists ? { id, name: "T" } : undefined),
    getTeammates: () => [],
    getTeamTasks: () => [],
    updateTeam: (teamId: string, u: { task?: string }) => updates.push({ teamId, updates: u }),
    addMessage: () => undefined,
    setTaskStatus: () => undefined,
    updateTeammate: () => undefined,
  }
  const deps: StartTeamRunFromIMDeps = {
    loadStore: async () => store,
    loadRunTeamLifecycle: async () => async (teamId: string, d: Record<string, unknown>) => {
      runCalls.push({ teamId, deps: d })
      return { runId: "run_1", status: "completed" }
    },
    loadBuildDeps: async () => () => ({ notifierDeps: { marker: true } }),
  }
  return { runCalls, updates, deps }
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

  it("seeds the objective and launches runTeamLifecycle with triggeredFrom", async () => {
    const h = harness()
    const permissionCeiling = { disallowedTools: ["Bash"] }
    const buildDeps = jest.fn(() => ({ notifierDeps: { marker: true } }))
    h.deps.loadBuildDeps = async () => buildDeps
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
    // objective seeded
    expect(h.updates).toEqual([{ teamId: "team_x", updates: { task: "build a parser" } }])
    // lifecycle launched (await a microtask so the fire-and-forget call lands)
    await Promise.resolve()
    expect(h.runCalls).toHaveLength(1)
    expect(h.runCalls[0].teamId).toBe("team_x")
    expect(h.runCalls[0].deps.runId).toBe(res.runId)
    const triggeredFrom = h.runCalls[0].deps.triggeredFrom as Record<string, unknown>
    expect(triggeredFrom).toEqual({
      source: "im",
      adapterId: "tg-1",
      conversationKey: "telegram:tg-1:9",
      sessionId: "s1",
      characterId: "char_1",
    })
    expect(h.runCalls[0].deps.parentPermissionCeiling).toBe(permissionCeiling)
    expect(buildDeps).toHaveBeenCalledWith({
      entryPersona: { id: "char_1", name: "Sage", systemPrompt: "Be precise" },
    })
    // notifierDeps from buildAgentTeamRuntimeDeps merged in
    expect(h.runCalls[0].deps.notifierDeps).toEqual({ marker: true })
    // storeReader/storeWriter wired
    expect(h.runCalls[0].deps.storeReader).toBeDefined()
    expect(h.runCalls[0].deps.storeWriter).toBeDefined()
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
    runTeamLifecycleMock.mockClear()
    const res = await startTeamRunFromIM({
      teamId: "team_real",
      goal: "go",
      adapterId: "tg-1",
      conversationKey: "telegram:tg-1:1",
    })
    expect(res).toEqual({ started: true, runId: expect.stringMatching(/^run_team_/) })
    await Promise.resolve()
    expect(runTeamLifecycleMock).toHaveBeenCalledTimes(1)
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

  beforeEach(() => ensureImTeamExecutionRunMock.mockClear())

  it("creates the run and its conversation binding before firing the lifecycle", async () => {
    // putExecutionRunBinding had three call sites and none was a team run, so
    // a team dispatched from IM produced no card, no progress, and every
    // control callback was rejected as a conversation mismatch.
    const result = await startTeamRunFromIM({
      teamId: "team_real",
      goal: "Ship the thing",
      adapterId: "a1",
      conversationKey: "telegram:a1:c1",
      sessionId: "s1",
      session,
    })

    expect(result.started).toBe(true)
    expect(ensureImTeamExecutionRunMock).toHaveBeenCalledTimes(1)
    const arg = ensureImTeamExecutionRunMock.mock.calls[0][0] as {
      seed: { sourceRunId: string; objective: string }
      session: unknown
    }
    expect(arg.seed.sourceRunId).toBe(result.runId)
    expect(arg.seed.objective).toBe("Ship the thing")
    expect(arg.session).toBe(session)
  })

  it("still dispatches when no session is available, just uncarded", async () => {
    const result = await startTeamRunFromIM({
      teamId: "team_real",
      goal: "Ship the thing",
      adapterId: "a1",
      conversationKey: "telegram:a1:c1",
    })
    expect(result.started).toBe(true)
    expect(ensureImTeamExecutionRunMock).not.toHaveBeenCalled()
  })

  it("never lets a binding failure reject the dispatch", async () => {
    ensureImTeamExecutionRunMock.mockRejectedValueOnce(new Error("dexie down"))
    const result = await startTeamRunFromIM({
      teamId: "team_real",
      goal: "Ship the thing",
      adapterId: "a1",
      conversationKey: "telegram:a1:c1",
      session,
    })
    expect(result.started).toBe(true)
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

  beforeEach(() => runTeamLifecycleMock.mockClear())

  it("hands the lifecycle a way to ask when there is a surface to ask on", async () => {
    // `origin: "im"` alone put the run under the headless policy, whose plan
    // gate fails fast on the premise that there is no human. Supplying the
    // delegate is the proof that premise is false here.
    await startTeamRunFromIM({
      teamId: "team_real",
      goal: "Ship the thing",
      adapterId: "a1",
      conversationKey: "telegram:a1:c1",
      session: withTarget,
      initiatorUserId: "ou-user",
    })

    const deps = runTeamLifecycleMock.mock.calls[0]?.[1] as Record<string, unknown>
    expect(typeof deps.planApprovalDelegate).toBe("function")
    expect(deps.origin).toBe("im")
  })

  it("omits the delegate when there is genuinely no surface, keeping fail-fast", async () => {
    // Claiming a channel that cannot be serviced would turn a loud failure
    // into a silent hang, which is strictly worse.
    await startTeamRunFromIM({
      teamId: "team_real",
      goal: "Ship the thing",
      adapterId: "a1",
      conversationKey: "telegram:a1:c1",
      session: withoutTarget,
    })

    const deps = runTeamLifecycleMock.mock.calls[0]?.[1] as Record<string, unknown>
    expect(deps.planApprovalDelegate).toBeUndefined()
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
    expect(
      (runTeamLifecycleMock.mock.calls[0]?.[1] as Record<string, unknown>).requirePlanApprovalFloor
    ).toBe(true)

    runTeamLifecycleMock.mockClear()
    await startTeamRunFromIM({
      teamId: "team_real",
      goal: "Ship the thing",
      adapterId: "a1",
      conversationKey: "telegram:a1:c1",
      session: withTarget,
    })
    expect(
      (runTeamLifecycleMock.mock.calls[0]?.[1] as Record<string, unknown>).requirePlanApprovalFloor
    ).toBeUndefined()
  })
})
