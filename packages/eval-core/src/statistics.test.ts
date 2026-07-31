import { bootstrapMean, pairedBootstrap, paretoFrontier, type ParetoCandidate } from "./statistics"

describe("evaluation statistics", () => {
  it("produces deterministic paired confidence intervals from a seed", () => {
    const left = [0.9, 0.8, 0.7, 0.95, 0.85]
    const right = [0.4, 0.5, 0.45, 0.6, 0.55]

    expect(pairedBootstrap(left, right, { seed: 42, iterations: 2_000 })).toEqual(
      pairedBootstrap(left, right, { seed: 42, iterations: 2_000 })
    )
    expect(pairedBootstrap(left, right, { seed: 42, iterations: 2_000 })).toMatchObject({
      meanDifference: expect.any(Number),
      confidenceLevel: 0.95,
      separated: true,
      sampleSize: 5,
    })
  })

  it("rejects unpaired samples", () => {
    expect(() => pairedBootstrap([1], [1, 2], { seed: 1 })).toThrow(/paired/i)
    expect(() => pairedBootstrap([], [], { seed: 1 })).toThrow(/non-empty/i)
  })

  it("produces deterministic seeded intervals around a sample mean", () => {
    const first = bootstrapMean([1, 0, 1, 1, 0], { seed: 17, iterations: 2_000 })
    const second = bootstrapMean([1, 0, 1, 1, 0], { seed: 17, iterations: 2_000 })

    expect(first).toEqual(second)
    expect(first.mean).toBeCloseTo(0.6)
    expect(first.low).toBeLessThanOrEqual(first.mean)
    expect(first.high).toBeGreaterThanOrEqual(first.mean)
  })

  it("rejects an empty sample mean", () => {
    expect(() => bootstrapMean([], { seed: 1 })).toThrow(/non-empty/i)
  })

  it("keeps only non-dominated variants across mixed dimensions", () => {
    const frontier = paretoFrontier(
      [
        { id: "balanced", metrics: { quality: 0.9, cost: 0.4 } },
        { id: "cheap", metrics: { quality: 0.8, cost: 0.1 } },
        { id: "dominated", metrics: { quality: 0.7, cost: 0.6 } },
      ],
      [
        { metric: "quality", direction: "maximize", weight: 0.5 },
        { metric: "cost", direction: "minimize", weight: 0.5 },
      ]
    )

    expect(frontier.map((candidate) => candidate.id).sort()).toEqual(["balanced", "cheap"])
  })

  it("keeps incomparable candidates when a decision metric is missing", () => {
    const candidates: ParetoCandidate[] = [
      { id: "complete", metrics: { quality: 0.9, cost: 0.4 } },
      { id: "missing", metrics: { quality: 0.8 } },
    ]

    expect(
      paretoFrontier(candidates, [
        { metric: "quality", direction: "maximize", weight: 0.5 },
        { metric: "cost", direction: "minimize", weight: 0.5 },
      ])
    ).toEqual(candidates)
  })
})
