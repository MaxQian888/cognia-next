import { buildBlindAssignments, evaluateJudgeCalibration } from "./judging"

describe("blind subjective judging", () => {
  it("anonymizes and deterministically randomizes A/B orientation", () => {
    const pairs = Array.from({ length: 12 }, (_, index) => ({
      pairId: `pair-${index}`,
      first: { variantId: "variant-a", sampleId: `a-${index}`, output: `A ${index}` },
      second: { variantId: "variant-b", sampleId: `b-${index}`, output: `B ${index}` },
    }))
    const first = buildBlindAssignments(pairs, 42)
    const second = buildBlindAssignments(pairs, 42)

    expect(first).toEqual(second)
    expect(JSON.stringify(first.publicAssignments)).not.toContain("variant-a")
    expect(new Set(first.publicAssignments.map((item) => item.left.output[0])).size).toBe(2)
    expect(Object.keys(first.privateMapping)).toHaveLength(12)
  })

  it("enforces the formal 30-anchor, kappa, and accuracy thresholds", () => {
    expect(evaluateJudgeCalibration({ anchorCount: 30, kappa: 0.6, accuracy: 0.8 })).toEqual({
      passed: true,
      failures: [],
    })
    expect(evaluateJudgeCalibration({ anchorCount: 29, kappa: 0.59, accuracy: 0.79 })).toEqual({
      passed: false,
      failures: ["anchor_count", "kappa", "accuracy"],
    })
  })
})
