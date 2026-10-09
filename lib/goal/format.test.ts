import {
  formatGoalDuration,
  formatGoalTokens,
  goalBudgetPercent,
  goalDurationParts,
  goalRunDurationMs,
} from "./format"

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

describe("formatGoalTokens", () => {
  it("compacts in English", () => {
    expect(formatGoalTokens(42_000, "en")).toBe("42K")
    expect(formatGoalTokens(1_500, "en")).toBe("1.5K")
    expect(formatGoalTokens(999, "en")).toBe("999")
  })

  it("compacts in zh-CN with the locale's own suffix and keeps one fraction digit", () => {
    expect(formatGoalTokens(42_000, "zh-CN")).toBe("4.2万")
  })

  it("clamps negatives and non-finite input to zero", () => {
    expect(formatGoalTokens(-5, "en")).toBe("0")
    expect(formatGoalTokens(Number.NaN, "en")).toBe("0")
    expect(formatGoalTokens(Number.POSITIVE_INFINITY, "en")).toBe("0")
  })
})

describe("goalDurationParts", () => {
  it("uses seconds under a minute", () => {
    expect(goalDurationParts(0)).toEqual({ value: 0, unit: "second" })
    expect(goalDurationParts(59 * SECOND + 999)).toEqual({ value: 59, unit: "second" })
  })

  it("switches to minutes at exactly one minute", () => {
    expect(goalDurationParts(60 * SECOND)).toEqual({ value: 1, unit: "minute" })
    expect(goalDurationParts(59 * MINUTE + 59 * SECOND)).toEqual({ value: 59, unit: "minute" })
  })

  it("switches to hours at one hour and stays in hours under two days", () => {
    expect(goalDurationParts(HOUR)).toEqual({ value: 1, unit: "hour" })
    expect(goalDurationParts(36 * HOUR)).toEqual({ value: 36, unit: "hour" })
    expect(goalDurationParts(47 * HOUR + 59 * MINUTE)).toEqual({ value: 47, unit: "hour" })
  })

  it("switches to days at 48 hours", () => {
    expect(goalDurationParts(48 * HOUR)).toEqual({ value: 2, unit: "day" })
    expect(goalDurationParts(21 * DAY + 5 * HOUR)).toEqual({ value: 21, unit: "day" })
  })

  it("treats negative / non-finite durations as zero seconds", () => {
    expect(goalDurationParts(-HOUR)).toEqual({ value: 0, unit: "second" })
    expect(goalDurationParts(Number.NaN)).toEqual({ value: 0, unit: "second" })
  })
})

describe("formatGoalDuration", () => {
  it("formats through Intl unit style in the given locale", () => {
    const expectedEn = (value: number, unit: string) =>
      new Intl.NumberFormat("en", { style: "unit", unit, unitDisplay: "short" }).format(value)
    expect(formatGoalDuration(3 * HOUR, "en")).toBe(expectedEn(3, "hour"))
    expect(formatGoalDuration(3 * DAY, "en")).toBe(expectedEn(3, "day"))
    expect(formatGoalDuration(30 * SECOND, "en")).toBe(expectedEn(30, "second"))
    expect(formatGoalDuration(3 * HOUR, "en")).toMatch(/^3\s?hr/)
  })

  it("spells the unit in zh-CN", () => {
    expect(formatGoalDuration(3 * DAY, "zh-CN")).toContain("3")
    expect(formatGoalDuration(3 * DAY, "zh-CN")).toContain("天")
    expect(formatGoalDuration(3 * HOUR, "zh-CN")).toContain("小时")
  })

  it("never prints a raw minute count for multi-day runs", () => {
    expect(formatGoalDuration(21 * DAY, "en")).not.toContain("30240")
  })
})

describe("goalRunDurationMs", () => {
  it("measures a finished goal to endedAt, ignoring now", () => {
    expect(goalRunDurationMs({ createdAt: 1_000, endedAt: 5_000 }, 99_999)).toBe(4_000)
  })

  it("measures an open goal to now", () => {
    expect(goalRunDurationMs({ createdAt: 1_000 }, 7_000)).toBe(6_000)
  })

  it("is never negative", () => {
    expect(goalRunDurationMs({ createdAt: 10_000 }, 5_000)).toBe(0)
    expect(goalRunDurationMs({ createdAt: 10_000, endedAt: 9_000 }, 50_000)).toBe(0)
  })
})

describe("goalBudgetPercent", () => {
  it("returns the share used", () => {
    expect(goalBudgetPercent(50, 200)).toBe(25)
  })

  it("clamps above 100 and below 0", () => {
    expect(goalBudgetPercent(500, 200)).toBe(100)
    expect(goalBudgetPercent(-10, 200)).toBe(0)
  })

  it("reads 0 for a non-positive or invalid budget", () => {
    expect(goalBudgetPercent(10, 0)).toBe(0)
    expect(goalBudgetPercent(10, -1)).toBe(0)
    expect(goalBudgetPercent(10, Number.NaN)).toBe(0)
  })
})
