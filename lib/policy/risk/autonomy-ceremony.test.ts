import type { AutonomyLevel } from "@cognia/agent-config-types/agent-composition"
import { AUTONOMY_LEVELS } from "@cognia/agent-config-types/agent-composition"

import { ceremonyFloor, effectiveCeremony } from "./autonomy-ceremony"
import type { RiskAssessment } from "./classify-risk"

const LOW: RiskAssessment = { tier: "low", surfaces: [], reason: "low" }
const MEDIUM: RiskAssessment = {
  tier: "medium",
  surfaces: [{ id: "credential-auth", evidence: "keychain_read" }],
  reason: "medium — credential-auth",
}
const HIGH: RiskAssessment = {
  tier: "high",
  surfaces: [{ id: "computer-use", evidence: "computer_use" }],
  reason: "high — computer-use",
}

describe("ceremonyFloor", () => {
  it("owes nothing for observe, act and autopilot", () => {
    for (const level of ["observe", "act", "autopilot"] as const) {
      expect(ceremonyFloor(level)).toEqual({
        gate: false,
        requirePlanApproval: false,
        requireAcceptance: false,
        manualContinue: false,
      })
    }
  })

  it("requires acceptance for suggest — this is what makes a reply a draft", () => {
    expect(ceremonyFloor("suggest")).toEqual({
      gate: true,
      requirePlanApproval: true,
      requireAcceptance: true,
      manualContinue: false,
    })
  })

  it("raises only the surface-agnostic gate bit for confirm", () => {
    expect(ceremonyFloor("confirm")).toEqual({
      gate: true,
      requirePlanApproval: false,
      requireAcceptance: false,
      manualContinue: false,
    })
  })

  it("never raises manualContinue — that is a risk property, not a preference", () => {
    for (const level of AUTONOMY_LEVELS) {
      expect(ceremonyFloor(level).manualContinue).toBe(false)
    }
  })
})

describe("effectiveCeremony", () => {
  it("keeps the quick lane frictionless: act + low risk owes nothing", () => {
    expect(effectiveCeremony("act", LOW)).toEqual({
      gate: false,
      requirePlanApproval: false,
      requireAcceptance: false,
      manualContinue: false,
    })
  })

  it("raises the operator floor even when risk is low", () => {
    expect(effectiveCeremony("suggest", LOW)).toMatchObject({
      gate: true,
      requirePlanApproval: true,
      requireAcceptance: true,
    })
  })

  it("raises the risk requirement even when the operator asked for none", () => {
    expect(effectiveCeremony("act", MEDIUM)).toMatchObject({
      gate: true,
      requirePlanApproval: true,
      requireAcceptance: true,
    })
  })

  it("autopilot can never lower a risk-derived ceremony", () => {
    for (const assessment of [MEDIUM, HIGH]) {
      const withAutopilot = effectiveCeremony("autopilot", assessment)
      const riskOnly = effectiveCeremony("act", assessment)
      expect(withAutopilot).toEqual(riskOnly)
      expect(withAutopilot.gate).toBe(true)
      expect(withAutopilot.requirePlanApproval).toBe(true)
    }
  })

  it("is monotonic: no level can clear a bit another source set", () => {
    for (const level of AUTONOMY_LEVELS as readonly AutonomyLevel[]) {
      for (const assessment of [LOW, MEDIUM, HIGH]) {
        const composed = effectiveCeremony(level, assessment)
        const floor = ceremonyFloor(level)
        for (const key of [
          "gate",
          "requirePlanApproval",
          "requireAcceptance",
          "manualContinue",
        ] as const) {
          if (floor[key]) expect(composed[key]).toBe(true)
        }
      }
    }
  })

  it("keeps manualContinue for high risk regardless of autonomy", () => {
    expect(effectiveCeremony("autopilot", HIGH).manualContinue).toBe(true)
    expect(effectiveCeremony("suggest", MEDIUM).manualContinue).toBe(false)
  })
})
