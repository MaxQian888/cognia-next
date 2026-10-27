jest.mock("@/lib/ai/eval/team-execution", () => ({
  runIsolatedTeamEval: jest.fn(async () => ({
    runId: "isolated-run",
    status: "completed",
    output: { report: "final answer" },
    traceId: "tr",
    spans: [],
    wallTimeMs: 10,
    costKnown: false,
  })),
}))
jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: { getState: jest.fn() },
}))
jest.mock("@/lib/db/agent-traces", () => ({
  queryByTrace: jest.fn(async () => []),
}))
jest.mock("./trace-persistence", () => ({
  waitForEvalTracePersistence: jest.fn(async () => undefined),
}))

import { defaultTeamTargetDeps, extractTeamText } from "./team-default-deps"
import { runIsolatedTeamEval } from "@/lib/ai/eval/team-execution"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { queryByTrace } from "@/lib/db/agent-traces"
import { waitForEvalTracePersistence } from "./trace-persistence"
import type { EvalPersistenceScope } from "@/lib/db/eval-lab"

describe("extractTeamText", () => {
  it("prefers an ultracode report, then string, then JSON", () => {
    expect(extractTeamText({ report: "r" })).toBe("r")
    expect(extractTeamText("plain")).toBe("plain")
    expect(extractTeamText({ a: 1 })).toBe('{"a":1}')
    expect(extractTeamText(undefined)).toBe("")
  })
})

describe("defaultTeamTargetDeps", () => {
  beforeEach(() => jest.clearAllMocks())

  it("delegates the case to isolated execution rather than mutating live store callbacks", async () => {
    const scope = { db: {}, assertActive: jest.fn() } as unknown as EvalPersistenceScope
    const signal = new AbortController().signal
    const price = { inputPerMillion: 1, outputPerMillion: 2, currency: "USD" }
    const result = await defaultTeamTargetDeps(scope).runTeam({
      teamId: "tm1",
      prompt: "eval prompt",
      traceId: "tr",
      timeoutMs: 1000,
      maxCostUsd: 0.2,
      price,
      signal,
    })
    expect(runIsolatedTeamEval).toHaveBeenCalledWith({
      teamId: "tm1",
      prompt: "eval prompt",
      traceId: "tr",
      timeoutMs: 1000,
      maxCostUsd: 0.2,
      price,
      signal,
      scope,
    })
    expect(useAgentTeamStore.getState).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      text: "final answer",
      traceId: "tr",
      spans: [],
      costKnown: false,
      executionProfile: "isolated-text",
    })
  })

  it("does not dispatch a team when imports finish after cancellation", async () => {
    const controller = new AbortController()
    const run = defaultTeamTargetDeps().runTeam({
      teamId: "tm1",
      prompt: "private",
      traceId: "tr",
      signal: controller.signal,
    })
    controller.abort()
    await expect(run).rejects.toThrow()
    expect(runIsolatedTeamEval).not.toHaveBeenCalled()
  })

  it("fences dispatch when the account scope is already inactive", async () => {
    const scope = {
      db: {},
      assertActive() {
        throw new Error("Evaluation scope changed")
      },
    } as unknown as EvalPersistenceScope
    await expect(
      defaultTeamTargetDeps(scope).runTeam({
        teamId: "tm1",
        prompt: "private",
        traceId: "tr",
      })
    ).rejects.toThrow("Evaluation scope changed")
    expect(runIsolatedTeamEval).not.toHaveBeenCalled()
  })

  it("does not publish an isolated result after its account changes", async () => {
    let active = true
    const scope = {
      db: {},
      assertActive() {
        if (!active) throw new Error("Evaluation scope changed")
      },
    } as unknown as EvalPersistenceScope
    jest.mocked(runIsolatedTeamEval).mockImplementationOnce(async () => {
      active = false
      return {
        runId: "r",
        status: "completed",
        output: "private result",
        traceId: "tr",
        spans: [],
        wallTimeMs: 1,
        costKnown: false,
        executionProfile: "isolated-text",
      }
    })
    await expect(
      defaultTeamTargetDeps(scope).runTeam({
        teamId: "tm1",
        prompt: "private",
        traceId: "tr",
      })
    ).rejects.toThrow("Evaluation scope changed")
  })

  it("reports the supported text-only profile without claiming desktop tools", () => {
    expect(defaultTeamTargetDeps().isToolCapable()).toBe(false)
  })

  it("acknowledges buffered trace writes before a fallback persistent query", async () => {
    let committed = false
    jest.mocked(waitForEvalTracePersistence).mockImplementationOnce(async () => {
      committed = true
    })
    jest.mocked(queryByTrace).mockImplementationOnce(async () => {
      expect(committed).toBe(true)
      return []
    })
    await defaultTeamTargetDeps().fetchSpansByTrace("tr")
    expect(queryByTrace).toHaveBeenCalledWith("tr")
  })
})
