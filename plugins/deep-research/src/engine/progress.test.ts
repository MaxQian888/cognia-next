import { engineText, reportEngineProgress } from "./progress"

describe("engine text", () => {
  it("renders through the injected translator", () => {
    const text = jest.fn(
      (key: string, params?: Record<string, string | number>) =>
        `${key}:${JSON.stringify(params ?? {})}`
    )
    expect(engineText({ text }, "progress.reading", { count: 2 })).toBe(
      'progress.reading:{"count":2}'
    )
  })

  it("falls back to the key when no translator is injected", () => {
    expect(engineText({}, "progress.done")).toBe("progress.done")
  })

  it("reports progress with the rendered message, and tolerates no reporter", () => {
    const reportProgress = jest.fn()
    reportEngineProgress({ reportProgress, text: (key) => `t(${key})` }, 0.5, "progress.drafting")
    expect(reportProgress).toHaveBeenCalledWith(0.5, "t(progress.drafting)")
    expect(() => reportEngineProgress({}, 1, "progress.done")).not.toThrow()
  })
})
