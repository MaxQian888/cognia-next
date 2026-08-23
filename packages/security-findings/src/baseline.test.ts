import { baselineStateOf, compareToBaseline } from "./baseline"
import type { ScanReport, SecurityFinding } from "./types"

function finding(
  fingerprint: string,
  severity: SecurityFinding["severity"] = "high"
): SecurityFinding {
  return { fingerprint, ruleId: "r", title: fingerprint, severity, locations: [] }
}

function report(
  findings: SecurityFinding[],
  completeness: ScanReport["completeness"] = "complete"
): ScanReport {
  return { target: "example.com", completeness, findings }
}

describe("compareToBaseline", () => {
  it("splits reported findings into added and unchanged", () => {
    const result = compareToBaseline(report([finding("a"), finding("b")]), new Set(["a"]))
    expect(result.unchanged.map((f) => f.fingerprint)).toEqual(["a"])
    expect(result.added.map((f) => f.fingerprint)).toEqual(["b"])
  })

  it("lists baseline findings this scan did not report", () => {
    const result = compareToBaseline(report([finding("a")]), new Set(["a", "gone"]))
    expect(result.absent).toEqual(["gone"])
    expect(result.absentKnown).toBe(true)
  })

  it("treats everything as added when the baseline is empty", () => {
    const result = compareToBaseline(report([finding("a")]), new Set())
    expect(result.added).toHaveLength(1)
    expect(result.unchanged).toEqual([])
  })

  it("refuses to call baseline findings absent when the report was unreadable", () => {
    // An unreadable report has no findings; subtracting it from the baseline
    // would announce that every known vulnerability had been fixed.
    const result = compareToBaseline(report([], "unreadable"), new Set(["a", "b"]))
    expect(result.absent).toEqual([])
    expect(result.absentKnown).toBe(false)
  })

  it("does report absences for an empty (clean) scan", () => {
    // `empty` means the scanner ran and found nothing — that IS evidence.
    const result = compareToBaseline(report([], "empty"), new Set(["a"]))
    expect(result.absent).toEqual(["a"])
    expect(result.absentKnown).toBe(true)
  })
})

describe("baselineStateOf", () => {
  it("makes no claim when there is no baseline", () => {
    // Emitting `new` for a first scan would poison the next diff of that log.
    expect(baselineStateOf(finding("a"), undefined)).toBeUndefined()
  })

  it("marks known findings unchanged and others new", () => {
    const baseline = new Set(["a"])
    expect(baselineStateOf(finding("a"), baseline)).toBe("unchanged")
    expect(baselineStateOf(finding("b"), baseline)).toBe("new")
  })
})
