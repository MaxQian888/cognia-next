// Formatting rules for the ambient snapshot. The whole point of the module is
// that a partially-priced window can never render as a confident total, so
// most of these tests are about the dash and the "at least" prefix.

import { buildUsageGlance, type UsageGlanceQuery, type UsageGlanceSnapshotV1 } from "./usage-glance"
import {
  costConfidence,
  formatGlanceBudget,
  formatGlanceCost,
  formatGlanceMetric,
  formatGlanceQuota,
  formatGlanceTokens,
  formatTaskbarUsage,
  glanceSeverity,
  PERIOD_LABEL_KEYS,
  PERIOD_SUFFIX,
  sparklineSeries,
  UNKNOWN_COST,
} from "./usage-glance-format"
import { USAGE_GLANCE_PERIODS } from "./usage-glance"

const NOON = new Date(2026, 5, 5, 12, 0, 0).getTime()
const query: UsageGlanceQuery = { period: "today", scope: "cognia", metric: "spend" }

function snap(over: Partial<UsageGlanceSnapshotV1> = {}): UsageGlanceSnapshotV1 {
  return { ...buildUsageGlance({ rows: [], query, now: NOON }), ...over }
}

describe("costConfidence", () => {
  it("is exact when everything priced", () => {
    expect(costConfidence(snap({ turns: 3, unpricedTurns: 0 }))).toBe("exact")
  })

  it("is a lower bound when only some turns priced", () => {
    expect(costConfidence(snap({ turns: 3, unpricedTurns: 1 }))).toBe("lowerBound")
  })

  it("is unknown when nothing priced", () => {
    expect(costConfidence(snap({ turns: 3, unpricedTurns: 3 }))).toBe("unknown")
  })
})

describe("formatGlanceCost", () => {
  it("renders an exact total plainly", () => {
    expect(formatGlanceCost(snap({ knownCostUsd: 4.2, turns: 2 }))).toBe("$4.2")
  })

  it("renders a partial total as a lower bound", () => {
    expect(formatGlanceCost(snap({ knownCostUsd: 4.2, turns: 3, unpricedTurns: 1 }))).toBe("≥$4.2")
  })

  it("renders an entirely unpriced window as a dash, never as zero", () => {
    expect(formatGlanceCost(snap({ knownCostUsd: 0, turns: 3, unpricedTurns: 3 }))).toBe(
      UNKNOWN_COST
    )
  })

  it("renders a genuinely empty window as $0", () => {
    expect(formatGlanceCost(snap())).toBe("$0")
  })
})

describe("formatGlanceTokens / quota / budget", () => {
  it("compacts tokens", () => {
    expect(formatGlanceTokens(snap({ billableTokens: 1_234_567 }))).toBe("1.2M")
  })

  it("renders quota as a whole percent", () => {
    expect(
      formatGlanceQuota(
        snap({ quota: { worstUsedPct: 42.6, worstAccountKey: "a", resetAt: null } })
      )
    ).toBe("43%")
  })

  it("dashes an unconfigured quota rather than showing 0%", () => {
    expect(formatGlanceQuota(snap())).toBe(UNKNOWN_COST)
  })

  it("renders a budget ratio as a percent", () => {
    expect(
      formatGlanceBudget(
        snap({ budget: { ratio: 0.784, target: "global", period: "day", blocked: false } })
      )
    ).toBe("78%")
  })

  it("dashes an unset budget", () => {
    expect(formatGlanceBudget(snap())).toBe(UNKNOWN_COST)
  })
})

describe("formatGlanceMetric", () => {
  it("leads with whatever the query asked for", () => {
    const s = snap({ knownCostUsd: 3, turns: 1, billableTokens: 2000 })
    expect(formatGlanceMetric(s, "spend")).toBe("$3")
    expect(formatGlanceMetric(s, "tokens")).toBe("2k")
  })

  it("defaults to the snapshot's own metric", () => {
    const s = snap({ billableTokens: 2000, query: { ...query, metric: "tokens" } })
    expect(formatGlanceMetric(s)).toBe("2k")
  })
})

describe("formatTaskbarUsage", () => {
  it("omits the suffix for today, where a bare figure already reads as today", () => {
    expect(formatTaskbarUsage(snap({ knownCostUsd: 4.2, turns: 1 }))).toBe("$4.2")
  })

  it("appends a window suffix for every other period", () => {
    const weekly = snap({
      knownCostUsd: 4.2,
      turns: 1,
      query: { ...query, period: "7d" },
    })
    expect(formatTaskbarUsage(weekly)).toBe("$4.2 / wk")
  })

  it("shows nothing rather than a dash in the tightest space on screen", () => {
    expect(formatTaskbarUsage(snap({ turns: 3, unpricedTurns: 3 }))).toBeNull()
  })

  it("has a suffix and a label key for every period", () => {
    for (const period of USAGE_GLANCE_PERIODS) {
      expect(PERIOD_SUFFIX[period]).toBeTruthy()
      expect(PERIOD_LABEL_KEYS[period]).toBeTruthy()
    }
  })
})

describe("glanceSeverity", () => {
  it("prefers the budget, which is the number with a threshold", () => {
    expect(
      glanceSeverity(
        snap({
          budget: { ratio: 0.9, target: "g", period: "day", blocked: false },
          quota: { worstUsedPct: 10, worstAccountKey: "a", resetAt: null },
        })
      )
    ).toBe("warn")
  })

  it("escalates through warn, crit and exceeded", () => {
    const at = (ratio: number) =>
      glanceSeverity(snap({ budget: { ratio, target: "g", period: "day", blocked: false } }))
    expect(at(0.5)).toBe("ok")
    expect(at(0.85)).toBe("warn")
    expect(at(0.96)).toBe("crit")
    expect(at(1.2)).toBe("exceeded")
  })

  it("reports a blocked budget as exceeded whatever the ratio says", () => {
    expect(
      glanceSeverity(snap({ budget: { ratio: 0.1, target: "g", period: "day", blocked: true } }))
    ).toBe("exceeded")
  })

  it("falls back to the quota when no budget is set", () => {
    expect(
      glanceSeverity(snap({ quota: { worstUsedPct: 97, worstAccountKey: "a", resetAt: null } }))
    ).toBe("crit")
  })

  it("is unknown when neither is configured, not ok", () => {
    // "ok" would claim we checked and found headroom. We checked nothing.
    expect(glanceSeverity(snap())).toBe("unknown")
  })
})

describe("sparklineSeries", () => {
  it("pads a short history so the shape is not misread as a spike", () => {
    const s = snap({
      daily: [
        { day: "2026-06-04", knownCostUsd: 1, tokens: 10, turns: 1 },
        { day: "2026-06-05", knownCostUsd: 2, tokens: 20, turns: 1 },
      ],
    })
    expect(sparklineSeries(s, 7)).toEqual([0, 0, 0, 0, 0, 1, 2])
  })

  it("keeps only the most recent points", () => {
    const daily = Array.from({ length: 10 }, (_, i) => ({
      day: `2026-06-${String(i + 1).padStart(2, "0")}`,
      knownCostUsd: i,
      tokens: i,
      turns: 1,
    }))
    expect(sparklineSeries(snap({ daily }), 3)).toEqual([7, 8, 9])
  })

  it("can plot tokens instead of money", () => {
    const s = snap({ daily: [{ day: "d", knownCostUsd: 1, tokens: 99, turns: 1 }] })
    expect(sparklineSeries(s, 1, "tokens")).toEqual([99])
  })
})
