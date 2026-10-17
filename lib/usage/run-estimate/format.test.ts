import { EMPTY_ESTIMATE, type RunEstimate } from "./estimate"
import { formatRunEstimate } from "./format"

/** Echoes the key and its values so assertions read the structure, not wording. */
const t = (key: string, values?: Record<string, string | number>) =>
  values
    ? `${key}(${Object.entries(values)
        .map(([k, v]) => `${k}=${v}`)
        .join(",")})`
    : key

const estimate: RunEstimate = {
  confidence: "based",
  sampleCount: 23,
  tokens: { p10: 50_000, p50: 180_000, p90: 520_000 },
  costUsd: { p10: 0.8, p50: 2.1, p90: 5.4 },
  durationMs: { p10: 5 * 60_000, p50: 12.4 * 60_000, p90: 28 * 60_000 },
  stoppedShare: 0.3,
}

describe("formatRunEstimate", () => {
  it("renders cost, tokens and duration with confidence and the early-stop share", () => {
    const out = formatRunEstimate(estimate, t)
    expect(out.summary).toBe(
      [
        "cost(typical=$2.10,low=$0.80,high=$5.40)",
        "tokens(typical=180.0K,low=50.0K,high=520.0K)",
        "duration(typical=12m,low=5m,high=28m)",
      ].join(" · ")
    )
    expect(out.detail).toBe("confidence.based(count=23) · stopped(percent=30)")
  })

  it("omits figures it does not have and a zero early-stop share", () => {
    const out = formatRunEstimate(
      {
        ...estimate,
        tokens: null,
        durationMs: null,
        stoppedShare: 0,
        confidence: "rough",
        sampleCount: 2,
      },
      t
    )
    expect(out.summary).toBe("cost(typical=$2.10,low=$0.80,high=$5.40)")
    expect(out.detail).toBe("confidence.rough(count=2)")
  })

  it("says none when there is nothing to show", () => {
    expect(formatRunEstimate(EMPTY_ESTIMATE, t)).toEqual({ summary: "none", detail: null })
    expect(
      formatRunEstimate({ ...estimate, tokens: null, costUsd: null, durationMs: null }, t)
    ).toEqual({ summary: "none", detail: null })
  })

  it("says unavailable for a dormant surface", () => {
    expect(formatRunEstimate(EMPTY_ESTIMATE, t, { dormant: true })).toEqual({
      summary: "unavailable",
      detail: null,
    })
  })

  it("rounds long durations to minutes and hours", () => {
    const out = formatRunEstimate(
      {
        ...estimate,
        costUsd: null,
        tokens: null,
        durationMs: { p10: 59.6 * 60_000, p50: 60 * 60_000, p90: 95 * 60_000 },
      },
      t
    )
    expect(out.summary).toBe("duration(typical=1h,low=1h,high=1h 35m)")
  })

  it("keeps sub-minute durations precise", () => {
    const out = formatRunEstimate(
      {
        ...estimate,
        costUsd: null,
        tokens: null,
        durationMs: { p10: 2_000, p50: 30_000, p90: 59_000 },
      },
      t
    )
    expect(out.summary).toBe("duration(typical=30s,low=2.0s,high=59s)")
  })
})
