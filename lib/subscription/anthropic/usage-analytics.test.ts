import type { SubscriptionUsageRow } from "../core/types"
import {
  buildUtilizationSeries,
  levelForUtilizationPct,
  splitCountdown,
  summarizeCurrentWindow,
} from "./usage-analytics"

const NOW = new Date(2026, 4, 31, 12, 0, 0).getTime()

function row(overrides: Partial<SubscriptionUsageRow> = {}): SubscriptionUsageRow {
  return {
    fetchedAt: NOW,
    source: "passive",
    status: "allowed",
    representativeClaim: null,
    fiveHour: { utilization: 0.5, resetAt: NOW + 3_600_000, status: "allowed" },
    sevenDay: { utilization: 0.2, resetAt: NOW + 7 * 86_400_000, status: "allowed" },
    fallbackPercentage: null,
    overageDisabledReason: null,
    rawHeaders: {},
    ...overrides,
  }
}

describe("buildUtilizationSeries", () => {
  it("returns ascending percent points and converts fractions", () => {
    const series = buildUtilizationSeries([
      row({ fetchedAt: NOW, fiveHour: { utilization: 0.5, resetAt: 0, status: "" } }),
      row({ fetchedAt: NOW - 1000, fiveHour: { utilization: 0.25, resetAt: 0, status: "" } }),
    ])
    expect(series.map((p) => p.at)).toEqual([NOW - 1000, NOW])
    expect(series[0]!.fiveHour).toBe(25)
    expect(series[1]!.fiveHour).toBe(50)
  })

  it("maps absent windows to null", () => {
    const series = buildUtilizationSeries([row({ fiveHour: null, sevenDay: null })])
    expect(series[0]!.fiveHour).toBeNull()
    expect(series[0]!.sevenDay).toBeNull()
  })

  it("drops points older than the range cutoff", () => {
    const series = buildUtilizationSeries(
      [row({ fetchedAt: NOW }), row({ fetchedAt: NOW - 10 * 86_400_000 })],
      { now: NOW, rangeMs: 7 * 86_400_000 }
    )
    expect(series).toHaveLength(1)
    expect(series[0]!.at).toBe(NOW)
  })

  it("keeps everything when no range is given", () => {
    const series = buildUtilizationSeries([row({ fetchedAt: NOW - 99 * 86_400_000 }), row()])
    expect(series).toHaveLength(2)
  })
})

describe("levelForUtilizationPct", () => {
  it("classifies ok / warn / crit at the boundaries", () => {
    expect(levelForUtilizationPct(50, 90)).toBe("ok")
    expect(levelForUtilizationPct(90, 90)).toBe("warn")
    expect(levelForUtilizationPct(99.9, 90)).toBe("warn")
    expect(levelForUtilizationPct(100, 90)).toBe("crit")
    expect(levelForUtilizationPct(120, 90)).toBe("crit")
  })
})

describe("summarizeCurrentWindow", () => {
  it("returns null without a snapshot", () => {
    expect(summarizeCurrentWindow(null)).toBeNull()
    expect(summarizeCurrentWindow(undefined)).toBeNull()
  })

  it("distils windows with level + countdown", () => {
    const summary = summarizeCurrentWindow(
      row({
        status: "allowed_warning",
        representativeClaim: "five_hour",
        fallbackPercentage: 12,
        overageDisabledReason: "billing",
        fiveHour: { utilization: 0.95, resetAt: NOW + 1_800_000, status: "" },
        sevenDay: { utilization: 1.0, resetAt: NOW - 1000, status: "" },
      }),
      { now: NOW, warnThresholdPct: 90 }
    )
    expect(summary).not.toBeNull()
    expect(summary!.status).toBe("allowed_warning")
    expect(summary!.representativeClaim).toBe("five_hour")
    expect(summary!.fallbackPercentage).toBe(12)
    expect(summary!.overageDisabledReason).toBe("billing")
    expect(summary!.fiveHour).toEqual({
      utilization: 95,
      level: "warn",
      resetAt: NOW + 1_800_000,
      msUntilReset: 1_800_000,
    })
    expect(summary!.sevenDay!.level).toBe("crit")
    // resetAt already in the past clamps to 0.
    expect(summary!.sevenDay!.msUntilReset).toBe(0)
  })

  it("tolerates missing windows", () => {
    const summary = summarizeCurrentWindow(row({ fiveHour: null, sevenDay: null }), { now: NOW })
    expect(summary!.fiveHour).toBeNull()
    expect(summary!.sevenDay).toBeNull()
  })
})

describe("splitCountdown", () => {
  it("splits hours and minutes", () => {
    expect(splitCountdown(2 * 3_600_000 + 14 * 60_000)).toEqual({
      expired: false,
      hours: 2,
      minutes: 14,
    })
  })

  it("reports sub-hour as minutes only", () => {
    expect(splitCountdown(45 * 60_000)).toEqual({ expired: false, hours: 0, minutes: 45 })
  })

  it("flags expired at or below zero", () => {
    expect(splitCountdown(0).expired).toBe(true)
    expect(splitCountdown(-1000).expired).toBe(true)
    expect(splitCountdown(Number.NaN).expired).toBe(true)
  })
})
