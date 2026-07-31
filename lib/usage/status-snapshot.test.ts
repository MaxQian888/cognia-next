import type { SessionUsageRow } from "@/lib/db/session-usage"
import {
  buildUsageCardMarkdown,
  buildUsageStatusSnapshot,
  formatCompactTokens,
  formatCompactUsd,
  formatShortStatus,
  truncateWeighted,
  weightedLength,
  windowStart,
} from "./status-snapshot"

const NOW = new Date("2026-07-08T12:00:00Z").getTime()

function row(overrides: Partial<SessionUsageRow> = {}): SessionUsageRow {
  return {
    messageId: `m-${Math.random()}`,
    sessionId: "s1",
    at: NOW - 60_000,
    model: "claude-sonnet-5",
    inputTokens: 1000,
    outputTokens: 500,
    cacheCreationTokens: 0,
    cacheReadTokens: 200,
    costUsd: 0.5,
    durationMs: 1000,
    ...overrides,
  }
}

describe("windowStart", () => {
  it("today = local midnight", () => {
    const start = windowStart("today", NOW)
    const d = new Date(start)
    expect(d.getHours()).toBe(0)
    expect(d.getMinutes()).toBe(0)
    expect(start).toBeLessThanOrEqual(NOW)
  })

  it("7d / 30d are rolling windows", () => {
    expect(windowStart("7d", NOW)).toBe(NOW - 7 * 86_400_000)
    expect(windowStart("30d", NOW)).toBe(NOW - 30 * 86_400_000)
  })
})

describe("buildUsageStatusSnapshot", () => {
  it("sums in-window rows and excludes older ones", () => {
    const rows = [
      row(),
      row({ inputTokens: 2000, outputTokens: 0, cacheReadTokens: 0, costUsd: 1 }),
      row({ at: NOW - 40 * 86_400_000, inputTokens: 999_999 }), // out of 30d window
    ]
    const snap = buildUsageStatusSnapshot(rows, { window: "30d", now: NOW })
    expect(snap.turns).toBe(2)
    expect(snap.inputTokens).toBe(3000)
    expect(snap.outputTokens).toBe(500)
    expect(snap.totalTokens).toBe(3000 + 500 + 200)
    expect(snap.costUsd).toBeCloseTo(1.5)
  })

  it("ranks top models by cost", () => {
    const rows = [
      row({ model: "a", costUsd: 0.1 }),
      row({ model: "b", costUsd: 5 }),
      row({ model: "c", costUsd: 1 }),
      row({ model: "d", costUsd: 0.05 }),
    ]
    const snap = buildUsageStatusSnapshot(rows, { window: "7d", now: NOW, topModelCount: 2 })
    expect(snap.topModels.map((m) => m.model)).toEqual(["b", "c"])
  })

  it("handles empty input", () => {
    const snap = buildUsageStatusSnapshot([], { now: NOW })
    expect(snap.turns).toBe(0)
    expect(snap.totalTokens).toBe(0)
    expect(snap.topModels).toEqual([])
  })
})

describe("formatters", () => {
  it("formatCompactTokens", () => {
    expect(formatCompactTokens(0)).toBe("0")
    expect(formatCompactTokens(999)).toBe("999")
    expect(formatCompactTokens(1234)).toBe("1.2k")
    expect(formatCompactTokens(1_000_000)).toBe("1M")
    expect(formatCompactTokens(1_234_567)).toBe("1.2M")
    expect(formatCompactTokens(2_500_000_000)).toBe("2.5B")
    expect(formatCompactTokens(-5)).toBe("0")
  })

  it("formatCompactUsd", () => {
    expect(formatCompactUsd(0)).toBe("$0")
    expect(formatCompactUsd(0.416)).toBe("$0.42")
    expect(formatCompactUsd(3.4)).toBe("$3.4")
    expect(formatCompactUsd(3.0)).toBe("$3")
    expect(formatCompactUsd(120.4)).toBe("$120")
  })

  it("weightedLength counts CJK as 2", () => {
    expect(weightedLength("AI 1.2M")).toBe(7)
    expect(weightedLength("用量")).toBe(4)
    expect(weightedLength("AI用量")).toBe(6)
  })

  it("truncateWeighted respects the unit budget", () => {
    expect(truncateWeighted("用量统计1234", 8)).toBe("用量统计")
    expect(truncateWeighted("abcdef", 3)).toBe("abc")
    expect(truncateWeighted("abc", 10)).toBe("abc")
  })
})

describe("formatShortStatus", () => {
  const snap = buildUsageStatusSnapshot(
    [row({ inputTokens: 1_000_000, outputTokens: 200_000, cacheReadTokens: 0, costUsd: 3.4 })],
    { window: "today", now: NOW }
  )

  it("emits prefix + tokens + cost within a 20-unit budget", () => {
    const s = formatShortStatus(snap)
    expect(s).toBe("AI 1.2M $3.4")
    expect(weightedLength(s)).toBeLessThanOrEqual(20)
  })

  it("degrades gracefully on tiny budgets", () => {
    expect(formatShortStatus(snap, { maxUnits: 8 })).toBe("AI 1.2M")
    expect(formatShortStatus(snap, { maxUnits: 4 })).toBe("1.2M")
    expect(formatShortStatus(snap, { maxUnits: 2 })).toBe("1.")
  })

  it("supports a CJK prefix within the Lark budget", () => {
    const s = formatShortStatus(snap, { prefix: "AI用量" })
    expect(weightedLength(s)).toBeLessThanOrEqual(20)
    expect(s.startsWith("AI用量")).toBe(true)
  })
})

describe("buildUsageCardMarkdown", () => {
  it("renders headline, cost, turns, and models", () => {
    const snap = buildUsageStatusSnapshot(
      [row({ model: "claude-sonnet-5", inputTokens: 10_000, costUsd: 1.2 })],
      { window: "today", now: NOW }
    )
    const md = buildUsageCardMarkdown(snap, { now: NOW })
    expect(md).toContain("Token Usage / 用量统计")
    expect(md).toContain("Today / 今日")
    expect(md).toContain("$1.2")
    expect(md).toContain("claude-sonnet-5")
    expect(md).toContain("2026-07-08 12:00")
  })

  it("omits the models line when empty", () => {
    const md = buildUsageCardMarkdown(buildUsageStatusSnapshot([], { now: NOW }), { now: NOW })
    expect(md).not.toContain("Models:")
  })
})
