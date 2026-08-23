import { deriveRuleId, normalizeFinding, normalizeReport, sortFindings } from "./normalize"

describe("deriveRuleId", () => {
  it("prefers an explicit rule field over everything else", () => {
    expect(deriveRuleId({ rule_id: "SQL-Injection", cwe: "CWE-89", title: "x" })).toBe(
      "sql-injection"
    )
    expect(deriveRuleId({ type: "XSS" })).toBe("xss")
    expect(deriveRuleId({ category: "Auth" })).toBe("auth")
  })

  it("falls back to CWE, then a title slug", () => {
    expect(deriveRuleId({ cwe: "CWE 89", title: "t" })).toBe("cwe-89")
    expect(deriveRuleId({ title: "Reflected XSS in /search!" })).toBe("reflected-xss-in-search")
  })

  it("never keys on the scanner's per-run id", () => {
    // Keying on `id` makes every finding new on every scan, which defeats
    // baselines and triage entirely.
    expect(deriveRuleId({ id: "vuln-7" })).toBe("unknown")
  })
})

describe("normalizeFinding", () => {
  it("maps snake_case and camelCase report fields alike", () => {
    const finding = normalizeFinding({
      rule_id: "sqli",
      title: "SQL injection",
      severity: "HIGH",
      cvss: "8.1",
      description: "d",
      remediation_steps: "fix it",
      cwe: "CWE-89",
      cve: "CVE-2024-1",
      code_locations: [{ file: "src/db.ts", start_line: 4, end_line: 9 }],
    })
    expect(finding).toMatchObject({
      ruleId: "sqli",
      title: "SQL injection",
      severity: "high",
      cvss: 8.1,
      remediation: "fix it",
      cwe: "CWE-89",
      cve: "CVE-2024-1",
      locations: [{ file: "src/db.ts", startLine: 4, endLine: 9 }],
    })
    expect(finding.fingerprint).toMatch(/^[0-9a-f]{16}$/)
  })

  it("records an endpoint location with an upper-cased method", () => {
    const finding = normalizeFinding({ title: "t", endpoint: "/login", method: "post" })
    expect(finding.locations).toEqual([{ endpoint: "/login", method: "POST" }])
  })

  it("drops a code location with no file rather than inventing one", () => {
    const finding = normalizeFinding({ title: "t", code_locations: [{ start_line: 3 }] })
    expect(finding.locations).toEqual([])
  })

  it("omits absent optional fields instead of emitting empty strings", () => {
    const finding = normalizeFinding({ title: "t", description: "   " })
    expect(finding.description).toBeUndefined()
    expect(finding.cvss).toBeUndefined()
  })

  it("titles an untitled finding rather than dropping it", () => {
    expect(normalizeFinding({}).title).toBe("Untitled finding")
  })
})

describe("normalizeReport", () => {
  const target = "https://example.com/"

  it("reads a bare array of reports", () => {
    const report = normalizeReport({
      target,
      report: [{ title: "a", severity: "high" }],
    })
    expect(report.completeness).toBe("complete")
    expect(report.target).toBe("example.com")
    expect(report.findings).toHaveLength(1)
  })

  it.each(["vulnerabilities", "reports", "findings", "results"])(
    "reads a report wrapped under %s",
    (key) => {
      const report = normalizeReport({ target, report: { [key]: [{ title: "a" }] } })
      expect(report.completeness).toBe("complete")
      expect(report.findings).toHaveLength(1)
    }
  )

  it("treats a missing artifact as empty, which is the clean-scan signal", () => {
    // Strix writes no report when it has nothing to report.
    const report = normalizeReport({ target, report: null })
    expect(report).toMatchObject({ completeness: "empty", findings: [] })
    expect(report.unreadableReason).toBeUndefined()
  })

  it("treats an unrecognisable payload as unreadable, NOT as zero findings", () => {
    const report = normalizeReport({ target, report: { unexpected: true } })
    expect(report.completeness).toBe("unreadable")
    expect(report.unreadableReason).toMatch(/recognisable finding list/)
  })

  it("treats a read failure as unreadable and keeps the reason", () => {
    const report = normalizeReport({ target, report: null, readError: "bad JSON at 12" })
    expect(report).toMatchObject({ completeness: "unreadable", unreadableReason: "bad JSON at 12" })
  })

  it("skips non-object entries without failing the whole report", () => {
    const report = normalizeReport({ target, report: ["nope", null, { title: "a" }] })
    expect(report.completeness).toBe("complete")
    expect(report.findings).toHaveLength(1)
  })

  it("collapses duplicate entries and keeps the most severe reading", () => {
    const report = normalizeReport({
      target,
      report: [
        { rule_id: "sqli", title: "t", severity: "low", code_locations: [{ file: "a.ts" }] },
        { rule_id: "sqli", title: "t", severity: "critical", code_locations: [{ file: "a.ts" }] },
      ],
    })
    expect(report.findings).toHaveLength(1)
    expect(report.findings[0].severity).toBe("critical")
  })

  it("keeps the more severe duplicate even when it comes first", () => {
    const report = normalizeReport({
      target,
      report: [
        { rule_id: "sqli", title: "t", severity: "critical", code_locations: [{ file: "a.ts" }] },
        { rule_id: "sqli", title: "t", severity: "low", code_locations: [{ file: "a.ts" }] },
      ],
    })
    expect(report.findings[0].severity).toBe("critical")
  })

  it("sorts most severe first with a stable tiebreak", () => {
    const report = normalizeReport({
      target,
      report: [
        { rule_id: "b", title: "b", severity: "low" },
        { rule_id: "a", title: "a", severity: "critical" },
        { rule_id: "c", title: "c", severity: "low" },
      ],
    })
    expect(report.findings.map((finding) => finding.title)).toEqual(["a", "b", "c"])
  })

  it("carries tool identity through when the caller knows it", () => {
    const report = normalizeReport({
      target,
      report: [],
      tool: { name: "strix", version: "1.2" },
    })
    expect(report.tool).toEqual({ name: "strix", version: "1.2" })
    expect(report.completeness).toBe("complete")
  })
})

describe("sortFindings", () => {
  it("does not mutate its input", () => {
    const input = [
      { fingerprint: "b", ruleId: "b", title: "b", severity: "low" as const, locations: [] },
      { fingerprint: "a", ruleId: "a", title: "a", severity: "critical" as const, locations: [] },
    ]
    const sorted = sortFindings(input)
    expect(sorted[0].title).toBe("a")
    expect(input[0].title).toBe("b")
  })

  it("breaks a title tie on the fingerprint", () => {
    const sorted = sortFindings([
      { fingerprint: "z", ruleId: "r", title: "t", severity: "low", locations: [] },
      { fingerprint: "a", ruleId: "r", title: "t", severity: "low", locations: [] },
    ])
    expect(sorted.map((finding) => finding.fingerprint)).toEqual(["a", "z"])
  })
})
