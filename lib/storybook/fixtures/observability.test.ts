import { buildSeries, makeRange, makeSpan } from "./observability"

describe("buildSeries", () => {
  it("includes provider and project breakdowns", () => {
    const now = Date.parse("2026-06-01T09:00:00.000Z")
    const series = buildSeries(
      [
        makeSpan({
          providerName: "openai",
          projectId: "project-a",
          startTime: now - 1_000,
        }),
      ],
      makeRange(now)
    )

    expect(series.breakdownProvider).toEqual([expect.objectContaining({ key: "openai", spans: 1 })])
    expect(series.breakdownProject).toEqual([
      expect.objectContaining({ key: "project-a", spans: 1 }),
    ])
  })
})
