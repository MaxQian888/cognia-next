import { acceptedCost, groupedBootstrapGate, type PromotionObservation } from "./grouped-bootstrap"
import { seededShuffle } from "./grouped-split"

/**
 * One run per arm per group. `candidateAccepted(g)` / `baselineAccepted(g)`
 * decide acceptance; costs are integer microusd.
 */
function pairedGroups(
  groups: number,
  candidate: { cost: (g: number) => number; accepted: (g: number) => boolean },
  baseline: { cost: (g: number) => number; accepted: (g: number) => boolean }
): PromotionObservation[] {
  const observations: PromotionObservation[] = []
  for (let g = 0; g < groups; g++) {
    const groupId = `session-${String(g).padStart(3, "0")}`
    observations.push({
      groupId,
      arm: "candidate",
      costMicrousd: candidate.cost(g),
      accepted: candidate.accepted(g),
    })
    observations.push({
      groupId,
      arm: "baseline",
      costMicrousd: baseline.cost(g),
      accepted: baseline.accepted(g),
    })
  }
  return observations
}

describe("acceptedCost", () => {
  it("keeps every cost in the numerator and only accepted runs in the denominator", () => {
    // 10 calls: 2 accepted, 3 degraded, 5 failed.
    const runs = [
      { costMicrousd: 1_000, accepted: true },
      { costMicrousd: 2_000, accepted: true },
      { costMicrousd: 3_000, accepted: false },
      { costMicrousd: 4_000, accepted: false },
      { costMicrousd: 5_000, accepted: false },
      { costMicrousd: 6_000, accepted: false },
      { costMicrousd: 7_000, accepted: false },
      { costMicrousd: 8_000, accepted: false },
      { costMicrousd: 9_000, accepted: false },
      { costMicrousd: 10_000, accepted: false },
    ]
    expect(acceptedCost(runs)).toEqual({
      runCount: 10,
      acceptedCount: 2,
      totalCostMicrousd: 55_000,
      costPerAcceptedMicrousd: 27_500,
      passRate: 0.2,
    })
  })

  it("is undefined, never zero, when nothing was accepted", () => {
    expect(acceptedCost([{ costMicrousd: 900, accepted: false }])).toMatchObject({
      totalCostMicrousd: 900,
      costPerAcceptedMicrousd: null,
      passRate: 0,
    })
    expect(acceptedCost([])).toEqual({
      runCount: 0,
      acceptedCount: 0,
      totalCostMicrousd: 0,
      costPerAcceptedMicrousd: null,
      passRate: null,
    })
  })

  it("refuses costs that are not non-negative integer microusd", () => {
    for (const costMicrousd of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => acceptedCost([{ costMicrousd, accepted: true }])).toThrow(
        expect.objectContaining({ code: "INVALID_COST" })
      )
    }
  })
})

describe("groupedBootstrapGate", () => {
  const everyTenthFails = (g: number) => g % 10 !== 3

  it("passes a cheaper candidate whose pass rate holds", () => {
    const observations = pairedGroups(
      40,
      { cost: (g) => 400 + (g % 7) * 10, accepted: everyTenthFails },
      { cost: (g) => 1_000 + (g % 5) * 20, accepted: everyTenthFails }
    )
    const result = groupedBootstrapGate(observations, { seed: 1, iterations: 2_000 })
    expect(result.verdict).toBe("pass")
    expect(result.passed).toBe(true)
    expect(result.reasons).toEqual([])
    expect(result.pairedGroupCount).toBe(40)
    expect(result.costPerAcceptedDeltaMicrousd.high).toBeLessThan(0)
    expect(result.costPerAcceptedDeltaMicrousd.low).toBeLessThanOrEqual(
      result.costPerAcceptedDeltaMicrousd.estimate as number
    )
    expect(result.passRateDelta).toEqual({ estimate: 0, low: 0, high: 0 })
    expect(result.candidate.acceptedCount).toBe(36)
  })

  it("fails a candidate that is not cheaper per accepted run", () => {
    const observations = pairedGroups(
      40,
      { cost: (g) => 1_100 + (g % 3) * 10, accepted: everyTenthFails },
      { cost: (g) => 1_000 + (g % 5) * 20, accepted: everyTenthFails }
    )
    const result = groupedBootstrapGate(observations, { seed: 1, iterations: 2_000 })
    expect(result).toMatchObject({ verdict: "fail", passed: false, reasons: ["COST_NOT_REDUCED"] })
  })

  it("fails a cheaper candidate that loses more than the pass-rate margin", () => {
    const observations = pairedGroups(
      60,
      { cost: () => 300, accepted: (g) => g % 10 < 6 },
      { cost: () => 1_000, accepted: (g) => g % 10 < 9 }
    )
    const result = groupedBootstrapGate(observations, { seed: 9, iterations: 2_000 })
    // The failed candidate runs still cost money: 60·300 / 36 accepted.
    expect(result.candidate.costPerAcceptedMicrousd).toBeCloseTo(500, 9)
    expect(result).toMatchObject({ verdict: "fail", reasons: ["PASS_RATE_BELOW_MARGIN"] })
    expect(result.passRateDelta.low as number).toBeLessThan(-0.01)
  })

  it("stays inconclusive without enough paired sessions", () => {
    const observations = pairedGroups(
      10,
      { cost: () => 100, accepted: () => true },
      { cost: () => 1_000, accepted: () => true }
    )
    const result = groupedBootstrapGate(observations, { seed: 1, iterations: 500 })
    expect(result).toMatchObject({
      verdict: "inconclusive",
      passed: false,
      reasons: ["INSUFFICIENT_GROUPS"],
    })
  })

  it("stays inconclusive when an arm accepted nothing, or a replicate can accept nothing", () => {
    const none = pairedGroups(
      40,
      { cost: () => 100, accepted: () => false },
      { cost: () => 1_000, accepted: () => true }
    )
    const noAccepted = groupedBootstrapGate(none, { seed: 1, iterations: 500 })
    expect(noAccepted).toMatchObject({
      verdict: "inconclusive",
      reasons: ["NO_ACCEPTED_CANDIDATE"],
    })
    expect(noAccepted.candidate.costPerAcceptedMicrousd).toBeNull()
    expect(noAccepted.costPerAcceptedDeltaMicrousd).toEqual({
      estimate: null,
      low: null,
      high: null,
    })

    // Only one of five sessions ever accepts a candidate run: many replicates
    // leave it out, and their accepted cost is undefined.
    const rare = pairedGroups(
      5,
      { cost: () => 100, accepted: (g) => g === 0 },
      { cost: () => 1_000, accepted: () => true }
    )
    const undefinedReplicates = groupedBootstrapGate(rare, {
      seed: 1,
      iterations: 500,
      minGroups: 5,
    })
    expect(undefinedReplicates).toMatchObject({
      verdict: "inconclusive",
      reasons: ["UNDEFINED_REPLICATES"],
    })
    expect(undefinedReplicates.undefinedReplicates).toBeGreaterThan(0)
    expect(undefinedReplicates.costPerAcceptedDeltaMicrousd.low).toBeNull()
  })

  it("resamples whole sessions: one session gives a zero-width interval", () => {
    // Observation-level resampling would spread these four runs; group-level
    // resampling can only redraw the one session, so every replicate is equal.
    const observations: PromotionObservation[] = [
      { groupId: "only", arm: "candidate", costMicrousd: 100, accepted: true },
      { groupId: "only", arm: "candidate", costMicrousd: 900, accepted: false },
      { groupId: "only", arm: "baseline", costMicrousd: 400, accepted: true },
      { groupId: "only", arm: "baseline", costMicrousd: 50, accepted: false },
    ]
    const result = groupedBootstrapGate(observations, { seed: 3, iterations: 1_000, minGroups: 1 })
    expect(result.costPerAcceptedDeltaMicrousd).toEqual({ estimate: 550, low: 550, high: 550 })
    expect(result.passRateDelta).toEqual({ estimate: 0, low: 0, high: 0 })
  })

  it("draws its bounds from the hand-enumerable session replicates", () => {
    // g1: candidate 100 (accepted) vs baseline 300 (accepted)
    // g2: candidate 500 (rejected) + 100 (accepted) vs baseline 200 (accepted)
    // Replicates {g1,g1} → 100 − 300 = −200; {g1,g2} → 350 − 250 = 100;
    // {g2,g2} → 600 − 200 = 400. Each extreme has probability 1/4, so the
    // one-sided 95% bounds are exactly −200 and 400.
    const observations: PromotionObservation[] = [
      { groupId: "g1", arm: "candidate", costMicrousd: 100, accepted: true },
      { groupId: "g1", arm: "baseline", costMicrousd: 300, accepted: true },
      { groupId: "g2", arm: "candidate", costMicrousd: 500, accepted: false },
      { groupId: "g2", arm: "candidate", costMicrousd: 100, accepted: true },
      { groupId: "g2", arm: "baseline", costMicrousd: 200, accepted: true },
    ]
    const result = groupedBootstrapGate(observations, { seed: 5, iterations: 10_000, minGroups: 2 })
    expect(result.costPerAcceptedDeltaMicrousd).toEqual({ estimate: 100, low: -200, high: 400 })
    // Pass-rate deltas: {g1,g1} → 1 − 1 = 0; {g1,g2} → 2/3 − 1; {g2,g2} → 1/2 − 1.
    expect(result.passRateDelta).toEqual({ estimate: 2 / 3 - 1, low: -0.5, high: 0 })
    expect(result).toMatchObject({
      verdict: "fail",
      reasons: ["COST_NOT_REDUCED", "PASS_RATE_BELOW_MARGIN"],
    })
  })

  it("leaves unpaired sessions out of the comparison and counts them", () => {
    const observations = [
      ...pairedGroups(
        30,
        { cost: () => 100, accepted: () => true },
        { cost: () => 200, accepted: () => true }
      ),
      {
        groupId: "candidate-only",
        arm: "candidate" as const,
        costMicrousd: 999_999,
        accepted: false,
      },
      { groupId: "baseline-only", arm: "baseline" as const, costMicrousd: 1, accepted: true },
    ]
    const result = groupedBootstrapGate(observations, { seed: 2, iterations: 500 })
    expect(result.pairedGroupCount).toBe(30)
    expect(result.unpairedGroupCount).toBe(2)
    expect(result.candidate.totalCostMicrousd).toBe(3_000)
    expect(result.verdict).toBe("pass")
  })

  it("is deterministic under a seed and independent of input order", () => {
    const observations = pairedGroups(
      35,
      { cost: (g) => 300 + ((g * 37) % 11) * 25, accepted: (g) => g % 6 !== 0 },
      { cost: (g) => 500 + ((g * 17) % 13) * 25, accepted: (g) => g % 7 !== 0 }
    )
    const first = groupedBootstrapGate(observations, { seed: 77, iterations: 3_000 })
    expect(groupedBootstrapGate(observations, { seed: 77, iterations: 3_000 })).toEqual(first)
    expect(
      groupedBootstrapGate(seededShuffle(observations, 4), { seed: 77, iterations: 3_000 })
    ).toEqual(first)
    expect(
      groupedBootstrapGate([...observations].reverse(), { seed: 77, iterations: 3_000 })
    ).toEqual(first)
  })

  it("rejects invalid options and observations", () => {
    expect(() => groupedBootstrapGate([], { seed: 0.5 })).toThrow(
      expect.objectContaining({ code: "INVALID_OPTION" })
    )
    expect(() => groupedBootstrapGate([], { seed: 1, confidenceLevel: 0.4 })).toThrow(
      expect.objectContaining({ code: "INVALID_OPTION" })
    )
    expect(() =>
      groupedBootstrapGate([{ groupId: "", arm: "candidate", costMicrousd: 1, accepted: true }], {
        seed: 1,
      })
    ).toThrow(expect.objectContaining({ code: "INVALID_SAMPLE" }))
    expect(() =>
      groupedBootstrapGate([{ groupId: "g", arm: "candidate", costMicrousd: -5, accepted: true }], {
        seed: 1,
      })
    ).toThrow(expect.objectContaining({ code: "INVALID_COST" }))
  })
})
