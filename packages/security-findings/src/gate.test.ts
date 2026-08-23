import { evaluateGate } from "./gate"
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

describe("evaluateGate", () => {
  it("passes a clean scan", () => {
    const result = evaluateGate(report([], "empty"), { failOn: "low" })
    expect(result).toMatchObject({ exitCode: 0, verdict: "clean", blocking: [] })
  })

  it("is report-only when no threshold was configured", () => {
    // Adopting the command must not start failing builds on day one; opting in
    // is explicit, and the CLI says out loud when nothing was configured.
    const result = evaluateGate(report([finding("a", "critical")]))
    expect(result.exitCode).toBe(0)
    expect(result.verdict).toBe("clean")
    expect(result.counts.critical).toBe(1)
  })

  it("exits 2 when a finding meets the threshold", () => {
    const result = evaluateGate(report([finding("a", "high")]), { failOn: "high" })
    expect(result).toMatchObject({ exitCode: 2, verdict: "threshold-met" })
    expect(result.blocking.map((f) => f.fingerprint)).toEqual(["a"])
  })

  it("ignores findings below the threshold", () => {
    const result = evaluateGate(report([finding("a", "medium")]), { failOn: "high" })
    expect(result.exitCode).toBe(0)
    expect(result.counts.medium).toBe(1)
  })

  it("exits 1 for an unreadable report, never 0", () => {
    // The scan did not answer the question. That is a different failure from
    // "your code has a critical", and only one is fixed by editing code.
    const result = evaluateGate(report([], "unreadable"), { failOn: "critical" })
    expect(result).toMatchObject({ exitCode: 1, verdict: "inconclusive" })
  })

  it("exits 1 for an unreadable report even with no threshold configured", () => {
    expect(evaluateGate(report([], "unreadable")).exitCode).toBe(1)
  })

  it("cannot be talked out of exit 1 by suppressing everything", () => {
    const result = evaluateGate(report([], "unreadable"), {
      failOn: "info",
      suppressed: new Set(["a", "b"]),
    })
    expect(result.exitCode).toBe(1)
  })

  it("counts suppressed findings but never blocks on them", () => {
    const result = evaluateGate(report([finding("a", "critical"), finding("b", "critical")]), {
      failOn: "high",
      suppressed: new Set(["a"]),
    })
    expect(result.exitCode).toBe(2)
    expect(result.blocking.map((f) => f.fingerprint)).toEqual(["b"])
    expect(result.suppressed.map((f) => f.fingerprint)).toEqual(["a"])
    // Counts describe the scan, not the policy — the critical is still there.
    expect(result.counts.critical).toBe(2)
  })

  it("passes when every blocking finding is suppressed", () => {
    const result = evaluateGate(report([finding("a", "critical")]), {
      failOn: "high",
      suppressed: new Set(["a"]),
    })
    expect(result).toMatchObject({ exitCode: 0, verdict: "clean" })
  })

  it("blocks only on new findings when asked", () => {
    const result = evaluateGate(
      report([finding("known", "critical"), finding("fresh", "critical")]),
      {
        failOn: "high",
        onlyNew: true,
        baseline: new Set(["known"]),
      }
    )
    expect(result.blocking.map((f) => f.fingerprint)).toEqual(["fresh"])
  })

  it("passes when every finding is already in the baseline", () => {
    const result = evaluateGate(report([finding("known", "critical")]), {
      failOn: "high",
      onlyNew: true,
      baseline: new Set(["known"]),
    })
    expect(result.exitCode).toBe(0)
  })

  it("treats every finding as new when only-new is asked for without a baseline", () => {
    // A missing baseline file must not become a silent pass. Over-reporting is
    // the safe direction, and the degradation is named so a caller can say so.
    const result = evaluateGate(report([finding("a", "critical")]), {
      failOn: "high",
      onlyNew: true,
    })
    expect(result.exitCode).toBe(2)
    expect(result.degradedReason).toBe("only-new-without-baseline")
  })

  it("does not claim degradation when a baseline was supplied", () => {
    const result = evaluateGate(report([finding("a")]), {
      failOn: "high",
      onlyNew: true,
      baseline: new Set(),
    })
    expect(result.degradedReason).toBeUndefined()
  })

  it("orders blocking findings as the report ordered them", () => {
    const result = evaluateGate(
      report([finding("a", "critical"), finding("b", "high"), finding("c", "low")]),
      { failOn: "high" }
    )
    expect(result.blocking.map((f) => f.fingerprint)).toEqual(["a", "b"])
  })

  it("fails on info only when info is the threshold", () => {
    expect(evaluateGate(report([finding("a", "info")]), { failOn: "info" }).exitCode).toBe(2)
    expect(evaluateGate(report([finding("a", "info")]), { failOn: "low" }).exitCode).toBe(0)
  })
})
