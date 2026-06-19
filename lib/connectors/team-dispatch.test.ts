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
    const res = await startTeamRunFromIM(
      {
        teamId: "team_x",
        goal: "build a parser",
        adapterId: "tg-1",
        conversationKey: "telegram:tg-1:9",
        sessionId: "s1",
      },
      h.deps
    )
    expect(res).toEqual({ started: true })
    // objective seeded
    expect(h.updates).toEqual([{ teamId: "team_x", updates: { task: "build a parser" } }])
    // lifecycle launched (await a microtask so the fire-and-forget call lands)
    await Promise.resolve()
    expect(h.runCalls).toHaveLength(1)
    expect(h.runCalls[0].teamId).toBe("team_x")
    const triggeredFrom = h.runCalls[0].deps.triggeredFrom as Record<string, unknown>
    expect(triggeredFrom).toEqual({
      source: "im",
      adapterId: "tg-1",
      conversationKey: "telegram:tg-1:9",
      sessionId: "s1",
    })
    // notifierDeps from buildAgentTeamRuntimeDeps merged in
    expect(h.runCalls[0].deps.notifierDeps).toEqual({ marker: true })
    // storeReader/storeWriter wired
    expect(h.runCalls[0].deps.storeReader).toBeDefined()
    expect(h.runCalls[0].deps.storeWriter).toBeDefined()
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
    expect(res).toEqual({ started: true })
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
