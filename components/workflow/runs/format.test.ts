import { buildSpans, formatDurationMs, formatRunDuration, formatRunStartedAt } from "./format"

describe("formatDurationMs", () => {
  it("formats sub-second values in ms", () => {
    expect(formatDurationMs(0)).toBe("0 ms")
    expect(formatDurationMs(450)).toBe("450 ms")
  })

  it("formats seconds with two decimals when small", () => {
    expect(formatDurationMs(1500)).toBe("1.50 s")
    expect(formatDurationMs(9999)).toBe("10.00 s")
  })

  it("formats minutes and seconds for medium durations", () => {
    expect(formatDurationMs(75_000)).toBe("1m 15s")
    expect(formatDurationMs(180_000)).toBe("3m 0s")
  })

  it("formats hours and minutes for long durations", () => {
    expect(formatDurationMs(3_900_000)).toBe("1h 5m")
  })

  it("returns em-dash for invalid input", () => {
    expect(formatDurationMs(-1)).toBe("—")
    expect(formatDurationMs(Number.NaN)).toBe("—")
  })
})

describe("formatRunDuration", () => {
  it('shows "running" for in-flight runs', () => {
    expect(formatRunDuration({ startedAt: 0, completedAt: undefined, status: "running" })).toBe(
      "running"
    )
    expect(formatRunDuration({ startedAt: 0, completedAt: undefined, status: "waiting" })).toBe(
      "running"
    )
  })

  it("shows wall-clock for terminal runs", () => {
    expect(formatRunDuration({ startedAt: 0, completedAt: 1500, status: "succeeded" })).toBe(
      "1.50 s"
    )
  })

  it("returns em-dash for terminal runs missing completedAt", () => {
    expect(formatRunDuration({ startedAt: 0, completedAt: undefined, status: "failed" })).toBe("—")
  })
})

describe("formatRunStartedAt", () => {
  it("formats a real timestamp without throwing", () => {
    const out = formatRunStartedAt(Date.UTC(2026, 4, 7, 12, 30, 0))
    expect(out).not.toBe("—")
    expect(out.length).toBeGreaterThan(0)
  })

  it("handles invalid input gracefully", () => {
    expect(formatRunStartedAt(Number.NaN)).toBe("—")
  })
})

it("keeps retry timing and terminal state in the shared span helper", () => {
  expect(
    buildSpans(
      [
        { id: "a", runId: "r", ts: 10, type: "step_started", stepId: "n" },
        { id: "b", runId: "r", ts: 20, type: "step_failed", stepId: "n" },
        { id: "c", runId: "r", ts: 30, type: "step_started", stepId: "n" },
        { id: "d", runId: "r", ts: 40, type: "step_completed", stepId: "n" },
      ],
      50
    )
  ).toEqual([{ stepId: "n", startTs: 10, endTs: 40, status: "succeeded", attemptCount: 2 }])
})
