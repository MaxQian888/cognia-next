import {
  SEVERITY_ORDER,
  atOrAboveSeverity,
  countBySeverity,
  isSeverity,
  normalizeSeverity,
  severityRank,
} from "./severity"

describe("severity", () => {
  it("orders most severe first", () => {
    expect(SEVERITY_ORDER).toEqual(["critical", "high", "medium", "low", "info"])
    expect(severityRank("critical")).toBeLessThan(severityRank("info"))
  })

  it("recognises only the known vocabulary", () => {
    expect(isSeverity("high")).toBe(true)
    expect(isSeverity("HIGH")).toBe(false)
    expect(isSeverity(7)).toBe(false)
  })

  it("floors an unknown severity at info rather than inventing one", () => {
    // Not `critical`: an unrecognised value must not block every build. Not
    // dropped either — the finding still appears in the report.
    expect(normalizeSeverity("catastrophic")).toBe("info")
    expect(normalizeSeverity(undefined)).toBe("info")
    expect(normalizeSeverity(null)).toBe("info")
    expect(normalizeSeverity("  HIGH  ")).toBe("high")
  })

  it("treats at-or-above as more severe, not numerically greater", () => {
    // Rank ascends as severity falls; reversing this builds a gate that passes
    // exactly the runs it should stop.
    expect(atOrAboveSeverity("critical", "high")).toBe(true)
    expect(atOrAboveSeverity("high", "high")).toBe(true)
    expect(atOrAboveSeverity("medium", "high")).toBe(false)
    expect(atOrAboveSeverity("info", "info")).toBe(true)
  })

  it("returns every bucket so callers need no fallbacks", () => {
    expect(countBySeverity(["high", "high", "info"])).toEqual({
      critical: 0,
      high: 2,
      medium: 0,
      low: 0,
      info: 1,
    })
    expect(countBySeverity([])).toEqual({
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      info: 0,
    })
  })
})
