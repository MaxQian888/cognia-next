import { requiredCeremony, type RequiredCeremony } from "./ceremony"
import type { RiskAssessment, RiskTier } from "./classify-risk"

const assessment = (tier: RiskTier): RiskAssessment => ({ tier, surfaces: [], reason: tier })

describe("requiredCeremony", () => {
  const table: Array<[RiskTier, RequiredCeremony]> = [
    [
      "low",
      { gate: false, requirePlanApproval: false, requireAcceptance: false, manualContinue: false },
    ],
    [
      "medium",
      { gate: true, requirePlanApproval: true, requireAcceptance: true, manualContinue: false },
    ],
    [
      "high",
      { gate: true, requirePlanApproval: true, requireAcceptance: true, manualContinue: true },
    ],
  ]

  it.each(table)("%s → the full ceremony shape", (tier, expected) => {
    expect(requiredCeremony(assessment(tier))).toEqual(expected)
  })

  it("only high escalates to manualContinue", () => {
    expect(requiredCeremony(assessment("medium")).manualContinue).toBe(false)
    expect(requiredCeremony(assessment("high")).manualContinue).toBe(true)
  })

  it("gate mirrors 'not the Quick lane' for every tier", () => {
    for (const [tier, expected] of table) {
      expect(requiredCeremony(assessment(tier)).gate).toBe(tier !== "low")
      expect(requiredCeremony(assessment(tier)).gate).toBe(expected.gate)
    }
  })

  it("returns a fresh object so a consumer mutating it cannot poison the next call", () => {
    const first = requiredCeremony(assessment("low"))
    first.gate = true
    expect(requiredCeremony(assessment("low")).gate).toBe(false)
  })
})
