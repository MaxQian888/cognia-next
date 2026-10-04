import { PERF_NAMESPACE } from "./perf-marker"
import { rendererTimingCategory, summarizeRendererMeasurements } from "./renderer-timings"

describe("renderer timings", () => {
  it("categorizes measures by their name prefix", () => {
    expect(rendererTimingCategory("chat:turn")).toBe("chat")
    expect(rendererTimingCategory("react:chat:list")).toBe("react")
    expect(rendererTimingCategory("workflow:save")).toBe("other")
  })

  it("summarizes each measure, chat first, newest activity first, skipping long tasks", () => {
    const rows = summarizeRendererMeasurements(
      new Map([
        [
          `${PERF_NAMESPACE}react:chat:list`,
          [
            { name: "", duration: 4, startTime: 50 },
            { name: "", duration: 8, startTime: 60 },
          ],
        ],
        [
          `${PERF_NAMESPACE}chat:turn`,
          [
            { name: "", duration: 100, startTime: 10 },
            { name: "", duration: 300, startTime: 20 },
            { name: "", duration: 200, startTime: 30 },
          ],
        ],
        [`${PERF_NAMESPACE}chat:dispatch-latency`, [{ name: "", duration: 5, startTime: 40 }]],
        ["renderer:long-task", [{ name: "", duration: 90, startTime: 70 }]],
        [`${PERF_NAMESPACE}empty`, []],
      ])
    )
    expect(rows.map((row) => row.name)).toEqual([
      "chat:dispatch-latency",
      "chat:turn",
      "react:chat:list",
    ])
    const turn = rows.find((row) => row.name === "chat:turn")!
    expect(turn).toMatchObject({
      category: "chat",
      count: 3,
      p50Ms: 200,
      maxMs: 300,
      lastMs: 200,
      lastStartTime: 30,
    })
    expect(turn.p95Ms).toBeCloseTo(290)
  })
})
