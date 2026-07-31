import { recommendVariants } from "./recommendation"
import type { EvalCandidateEvidence, EvalDecisionPolicy } from "./types"

const policy: EvalDecisionPolicy = {
  formal: true,
  dimensions: [
    { metric: "quality", direction: "maximize", weight: 0.7 },
    { metric: "cost", direction: "minimize", weight: 0.3 },
  ],
  constraints: [{ metric: "quality", operator: "gte", value: 0.8 }],
  confidenceLevel: 0.95,
  minimumEffectiveCases: 30,
}

const evidence = (overrides: Partial<EvalCandidateEvidence>): EvalCandidateEvidence => ({
  variantId: "a",
  effectiveCases: 40,
  metrics: { quality: 0.9, cost: 0.5 },
  intervals: { quality: { low: 0.87, high: 0.93 } },
  calibrationPassed: true,
  ...overrides,
})

describe("recommendVariants", () => {
  it("selects by utility only after constraints and Pareto filtering", () => {
    const result = recommendVariants(policy, [
      evidence({
        variantId: "quality",
        metrics: { quality: 0.95, cost: 0.8 },
        intervals: { quality: { low: 0.94, high: 0.97 }, cost: { low: 0.75, high: 0.85 } },
      }),
      evidence({
        variantId: "balanced",
        metrics: { quality: 0.91, cost: 0.2 },
        intervals: { quality: { low: 0.89, high: 0.92 }, cost: { low: 0.15, high: 0.25 } },
      }),
      evidence({ variantId: "invalid", metrics: { quality: 0.7, cost: 0.1 } }),
    ])

    expect(result.status).toBe("recommended")
    expect(result.recommendedVariantId).toBe("balanced")
    expect(result.excluded).toContainEqual(
      expect.objectContaining({ variantId: "invalid", reason: "constraint_failed" })
    )
  })

  it.each([
    ["insufficient_cases", [evidence({ effectiveCases: 29 })]],
    ["calibration_failed", [evidence({ calibrationPassed: false })]],
  ] as const)("returns no conclusion for %s", (reason, candidates) => {
    expect(recommendVariants(policy, candidates)).toMatchObject({ status: "no_conclusion", reason })
  })

  it("returns no conclusion when leading confidence intervals overlap", () => {
    const result = recommendVariants(policy, [
      evidence({ variantId: "a", intervals: { quality: { low: 0.85, high: 0.94 } } }),
      evidence({
        variantId: "b",
        metrics: { quality: 0.89, cost: 0.5 },
        intervals: { quality: { low: 0.86, high: 0.92 } },
      }),
    ])

    expect(result).toMatchObject({ status: "no_conclusion", reason: "confidence_overlap" })
  })

  it.each([
    ["gt", 0.9, 0.9],
    ["lt", 0.9, 0.9],
    ["lte", 0.8, 0.9],
  ] as const)("enforces the %s constraint operator", (operator, limit, quality) => {
    const constrainedPolicy: EvalDecisionPolicy = {
      ...policy,
      constraints: [{ metric: "quality", operator, value: limit }],
    }

    expect(
      recommendVariants(constrainedPolicy, [evidence({ metrics: { quality, cost: 0.5 } })])
    ).toMatchObject({ status: "no_conclusion", reason: "no_candidate_satisfies_constraints" })
  })

  it("fails a constraint when the candidate did not produce its metric", () => {
    expect(recommendVariants(policy, [evidence({ metrics: { cost: 0.2 } })])).toMatchObject({
      status: "no_conclusion",
      reason: "no_candidate_satisfies_constraints",
    })
  })

  it("can recommend when candidates have no comparable confidence intervals", () => {
    const result = recommendVariants(policy, [
      evidence({ variantId: "a", intervals: {} }),
      evidence({
        variantId: "b",
        metrics: { quality: 0.85, cost: 0.8 },
        intervals: {},
      }),
    ])

    expect(result).toMatchObject({ status: "recommended", recommendedVariantId: "a" })
  })
})
