import {
  findingStateOf,
  isSuppressed,
  suppressedFingerprints,
  toScanReport,
  toSecurityFinding,
} from "./triage"
import type { FindingStateRow, StrixFinding, StrixRun, SuppressionRule } from "../types"

function finding(over: Partial<StrixFinding> = {}): StrixFinding {
  return {
    runId: "run1",
    fingerprint: "fp1",
    ruleId: "sqli",
    vulnId: "vuln-1",
    title: "SQL injection",
    severity: "critical",
    ...over,
  }
}

function state(fingerprint: string, value: FindingStateRow["state"]): FindingStateRow {
  return { key: `t ${fingerprint}`, target: "t", fingerprint, state: value, updatedAt: 1 }
}

function rule(ruleId: string): SuppressionRule {
  return { id: `t::${ruleId}`, target: "t", ruleId, createdAt: 1 }
}

function run(over: Partial<StrixRun> = {}): StrixRun {
  return {
    runId: "run1",
    target: "https://example.com",
    startedAt: 1,
    status: "done",
    findingsCount: 1,
    authorizedAt: 1,
    ...over,
  }
}

describe("findingStateOf", () => {
  it("defaults to open when nothing was recorded", () => {
    expect(findingStateOf([], "fp1")).toBe("open")
    expect(findingStateOf([state("other", "accepted")], "fp1")).toBe("open")
  })

  it("reads a recorded verdict", () => {
    expect(findingStateOf([state("fp1", "false-positive")], "fp1")).toBe("false-positive")
  })

  it("treats a finding with no fingerprint as open", () => {
    expect(findingStateOf([state("fp1", "accepted")], undefined)).toBe("open")
  })
})

describe("isSuppressed", () => {
  it("mutes an accepted or false-positive finding", () => {
    expect(isSuppressed(finding(), { states: [state("fp1", "accepted")], rules: [] })).toBe(true)
    expect(isSuppressed(finding(), { states: [state("fp1", "false-positive")], rules: [] })).toBe(
      true
    )
  })

  it("does NOT mute a finding marked fixed", () => {
    // Still being reported after being called fixed is a contradiction worth
    // showing, not hiding.
    expect(isSuppressed(finding(), { states: [state("fp1", "fixed")], rules: [] })).toBe(false)
  })

  it("mutes a whole class through a suppression rule", () => {
    expect(isSuppressed(finding(), { states: [], rules: [rule("sqli")] })).toBe(true)
    expect(isSuppressed(finding(), { states: [], rules: [rule("xss")] })).toBe(false)
  })

  it("mutes a class instance that has no verdict of its own", () => {
    // The reason rules exist: a newly discovered instance of an accepted class
    // must not re-open a triage task.
    const fresh = finding({ fingerprint: "fp-new" })
    expect(isSuppressed(fresh, { states: [], rules: [rule("sqli")] })).toBe(true)
  })

  it("cannot mute a finding that has no ruleId through a rule", () => {
    expect(
      isSuppressed(finding({ ruleId: undefined }), { states: [], rules: [rule("sqli")] })
    ).toBe(false)
  })
})

describe("suppressedFingerprints", () => {
  it("collects only the muted ones", () => {
    const findings = [
      finding({ fingerprint: "a" }),
      finding({ fingerprint: "b" }),
      finding({ fingerprint: "c", ruleId: "xss" }),
    ]
    const suppressed = suppressedFingerprints(findings, {
      states: [state("a", "accepted")],
      rules: [rule("xss")],
    })
    expect(suppressed).toEqual(new Set(["a", "c"]))
  })

  it("never suppresses a legacy row that has no fingerprint", () => {
    // Safe direction: an un-suppressible finding is noise, but guessing at
    // identity would mute the wrong vulnerability.
    const legacy = finding({ fingerprint: undefined })
    expect(suppressedFingerprints([legacy], { states: [], rules: [rule("sqli")] })).toEqual(
      new Set()
    )
  })
})

describe("toSecurityFinding", () => {
  it("drops proof-of-concept code and snippets on the way out", () => {
    const exported = toSecurityFinding(
      finding({
        pocScriptCode: "curl --exploit",
        pocDescription: "step 1",
        technicalAnalysis: "root cause",
        impact: "rce",
        codeLocations: [{ file: "a.py", startLine: 4, snippet: "secret", label: "sink" }],
      })
    )
    expect(JSON.stringify(exported)).not.toContain("curl --exploit")
    expect(JSON.stringify(exported)).not.toContain("secret")
    expect(exported.locations).toEqual([{ file: "a.py", startLine: 4 }])
  })

  it("carries the fields a reviewer needs to act", () => {
    const exported = toSecurityFinding(
      finding({ cvss: 9.1, description: "d", remediationSteps: "fix", cwe: "CWE-89", cve: "CVE-1" })
    )
    expect(exported).toMatchObject({
      fingerprint: "fp1",
      ruleId: "sqli",
      severity: "critical",
      cvss: 9.1,
      description: "d",
      remediation: "fix",
      cwe: "CWE-89",
      cve: "CVE-1",
    })
  })

  it("keeps a legacy row in the export under a marked fallback identity", () => {
    const exported = toSecurityFinding(finding({ fingerprint: undefined, ruleId: undefined }))
    expect(exported.fingerprint).toBe("legacy:vuln-1")
    expect(exported.ruleId).toBe("unknown")
  })

  it("records an endpoint location with an upper-cased method", () => {
    const exported = toSecurityFinding(
      finding({ codeLocations: undefined, endpoint: "/login", method: "post" })
    )
    expect(exported.locations).toEqual([{ endpoint: "/login", method: "POST" }])
  })

  it("skips a code location that names no file", () => {
    const exported = toSecurityFinding(finding({ codeLocations: [{ startLine: 2 }] }))
    expect(exported.locations).toEqual([])
  })
})

describe("toScanReport", () => {
  it("reports a scan with findings as complete", () => {
    const report = toScanReport(run(), [finding()])
    expect(report).toMatchObject({ target: "example.com", completeness: "complete" })
    expect(report.findings).toHaveLength(1)
  })

  it("reports a scan with no findings as empty, not unreadable", () => {
    expect(toScanReport(run({ findingsCount: 0 }), []).completeness).toBe("empty")
  })

  it("reports an unparseable run as unreadable even though it has no findings", () => {
    // The single most important mapping in this file: without the flag, a run
    // whose report could not be parsed exports as a clean scan.
    const report = toScanReport(
      run({ status: "error", reportUnreadable: true, error: "bad JSON" }),
      []
    )
    expect(report.completeness).toBe("unreadable")
    expect(report.unreadableReason).toBe("bad JSON")
  })

  it("still reports unreadable when the error message is missing", () => {
    const report = toScanReport(run({ reportUnreadable: true }), [])
    expect(report.completeness).toBe("unreadable")
    expect(report.unreadableReason).toMatch(/could not be parsed/)
  })

  it("does not call an ordinary failed run unreadable", () => {
    // A scan that failed to start is a failure; it is not a report we could
    // not read, and conflating the two would make every failure inconclusive.
    expect(toScanReport(run({ status: "error", error: "docker down" }), []).completeness).toBe(
      "empty"
    )
  })

  it("names the tool so a SARIF consumer can attribute the run", () => {
    expect(toScanReport(run(), []).tool).toEqual({ name: "strix" })
  })
})
