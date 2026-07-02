import { runCouncilFromProposal, runEnsembleFromProposal } from "./run-executor"
import type { RunExecutorDeps } from "./run-executor"
import type { AutoOrchestrationProposal } from "./types"
import type { TeamRoutingAssessment } from "@/types/agent/agent-team"

const assessment: TeamRoutingAssessment = {
  recommendedPattern: "single_agent_recommended",
  confidence: 0.7,
  reason: "r",
  factors: {
    taskComplexity: "simple",
    specializationNeeded: false,
    contextIsolationNeeded: false,
    delegationCandidate: false,
    budgetPressure: "low",
  },
  createdAt: new Date(0),
}

const proposal = (objective: string): AutoOrchestrationProposal => ({
  objective,
  assessment,
  roster: [],
  tasks: [],
})

/** Fake routed runner that echoes the alias + records every call. */
function fakeDeps(aliases: string[]): RunExecutorDeps & {
  calls: Array<{ modelAlias: string; userPrompt: string }>
} {
  const calls: Array<{ modelAlias: string; userPrompt: string }> = []
  return {
    calls,
    loadAliases: async () => aliases,
    runPrompt: async ({ modelAlias, userPrompt }) => {
      calls.push({ modelAlias, userPrompt })
      return { completion: `answer(${modelAlias})`, model: modelAlias, provider: "test" }
    },
  }
}

describe("runCouncilFromProposal", () => {
  it("convenes a council over the redacted objective and returns a markdown report", async () => {
    const deps = fakeDeps(["fast", "balanced", "powerful"])
    const res = await runCouncilFromProposal(proposal("REDACTED objective"), deps)
    expect(res.ok).toBe(true)
    expect(res.markdown).toContain("Council:")
    // Councillors receive the (already redacted) objective verbatim — the PII
    // gate upstream is what makes this safe.
    expect(deps.calls.every((c) => c.userPrompt.includes("REDACTED objective"))).toBe(true)
  })

  it("returns ok:false with a clear message when no aliases are configured", async () => {
    const res = await runCouncilFromProposal(proposal("x"), fakeDeps([]))
    expect(res.ok).toBe(false)
    expect(res.markdown).toMatch(/No models to convene|aliases/i)
  })
})

describe("runEnsembleFromProposal", () => {
  it("samples the objective and synthesizes a report", async () => {
    const deps = fakeDeps(["fast", "balanced"])
    const res = await runEnsembleFromProposal(proposal("REDACTED task"), deps, { n: 3 })
    expect(res.ok).toBe(true)
    expect(res.markdown).toContain("Ensemble:")
    // 3 samples on the first alias + 1 synthesis on a distinct alias.
    const sampleCalls = deps.calls.filter((c) => c.modelAlias === "fast")
    expect(sampleCalls).toHaveLength(3)
    expect(sampleCalls.every((c) => c.userPrompt.includes("REDACTED task"))).toBe(true)
    expect(deps.calls.some((c) => c.modelAlias === "balanced")).toBe(true)
  })

  it("returns ok:false when no aliases are configured", async () => {
    const res = await runEnsembleFromProposal(proposal("x"), fakeDeps([]))
    expect(res.ok).toBe(false)
    expect(res.markdown).toMatch(/No models to sample/i)
  })

  it("reuses the sole alias for both sampling and synthesis", async () => {
    const deps = fakeDeps(["only"])
    const res = await runEnsembleFromProposal(proposal("t"), deps, { n: 2 })
    expect(res.ok).toBe(true)
    expect(deps.calls.every((c) => c.modelAlias === "only")).toBe(true)
  })
})
