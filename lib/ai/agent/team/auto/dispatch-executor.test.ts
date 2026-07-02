import { chooseExecutor } from "./dispatch-executor"
import type { TeamExecutionPattern, TeamRoutingAssessment } from "@/types/agent/agent-team"

const assess = (
  pattern: TeamExecutionPattern,
  over: Partial<TeamRoutingAssessment> = {}
): TeamRoutingAssessment => ({
  recommendedPattern: pattern,
  confidence: 0.8,
  reason: `because ${pattern}`,
  factors: {
    taskComplexity: "moderate",
    specializationNeeded: false,
    contextIsolationNeeded: false,
    delegationCandidate: false,
    budgetPressure: "low",
  },
  createdAt: new Date(0),
  ...over,
})

describe("chooseExecutor — pattern mapping", () => {
  const cases: Array<[TeamExecutionPattern, string]> = [
    ["single_agent_recommended", "single-send"],
    ["ultracode_orchestration", "team-ultracode"],
    ["manager_worker", "team-flat"],
    ["parallel_specialists", "team-flat"],
    ["background_handoff", "background-handoff"],
    ["external_handoff", "external-handoff"],
  ]
  it.each(cases)("maps %s → %s", (pattern, kind) => {
    const d = chooseExecutor(assess(pattern))
    expect(d.kind).toBe(kind)
    expect(d.fromPattern).toBe(pattern)
    expect(d.confidence).toBe(0.8)
    expect(d.reason).toBe(`because ${pattern}`)
  })
})

describe("chooseExecutor — consensus signal precedence", () => {
  it("verificationNeeded wins → ensemble (over any pattern)", () => {
    const d = chooseExecutor(assess("manager_worker"), { verificationNeeded: true })
    expect(d.kind).toBe("ensemble")
    expect(d.fromPattern).toBe("manager_worker")
  })

  it("consensusNeeded → council", () => {
    const d = chooseExecutor(assess("single_agent_recommended"), { consensusNeeded: true })
    expect(d.kind).toBe("council")
  })

  it("verification takes precedence over consensus when both set", () => {
    const d = chooseExecutor(assess("ultracode_orchestration"), {
      consensusNeeded: true,
      verificationNeeded: true,
    })
    expect(d.kind).toBe("ensemble")
  })

  it("ignores an empty signal and falls through to the pattern", () => {
    expect(chooseExecutor(assess("parallel_specialists"), {}).kind).toBe("team-flat")
    expect(
      chooseExecutor(assess("single_agent_recommended"), {
        consensusNeeded: false,
        verificationNeeded: false,
      }).kind
    ).toBe("single-send")
  })
})
