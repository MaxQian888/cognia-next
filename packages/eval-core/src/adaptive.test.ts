import { selectAdaptiveRepetitions } from "./adaptive"

describe("two-stage adaptive repetitions", () => {
  it("runs every candidate once and repeats only boundary candidates up to three total", () => {
    const plan = selectAdaptiveRepetitions(
      [
        {
          variantId: "clear",
          repetitions: 1,
          constraintMargins: [0.4],
          rankingInterval: [0.9, 0.95],
        },
        {
          variantId: "constraint",
          repetitions: 1,
          constraintMargins: [0.01],
          rankingInterval: [0.6, 0.8],
        },
        {
          variantId: "ranking",
          repetitions: 2,
          constraintMargins: [0.2],
          rankingInterval: [0.75, 0.85],
        },
      ],
      { boundaryMargin: 0.05 }
    )

    expect(plan).toEqual([
      { variantId: "constraint", nextRepetition: 2, reason: "constraint_boundary" },
      { variantId: "ranking", nextRepetition: 3, reason: "ranking_boundary" },
    ])
  })
})
