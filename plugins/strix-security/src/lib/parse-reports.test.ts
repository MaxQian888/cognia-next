import {
  normSeverity,
  normalizeFinding,
  parseRunJson,
  parseVulnerabilities,
  sortBySeverity,
} from "./parse-reports"
import type { StrixFinding } from "../types"

describe("normSeverity", () => {
  it("normalizes known severities case-insensitively", () => {
    expect(normSeverity("CRITICAL")).toBe("critical")
    expect(normSeverity("High")).toBe("high")
  })
  it("falls back to info for unknown/empty", () => {
    expect(normSeverity("weird")).toBe("info")
    expect(normSeverity(undefined)).toBe("info")
    expect(normSeverity(null)).toBe("info")
  })
})

describe("normalizeFinding", () => {
  it("maps snake_case Strix fields to the domain shape", () => {
    const raw = {
      id: "vuln-0001",
      title: "SQL Injection",
      severity: "high",
      cvss: 8.6,
      description: "found it",
      impact: "rce",
      target: "https://x",
      technical_analysis: "root cause",
      poc_description: "step 1",
      poc_script_code: "curl x",
      remediation_steps: "parameterize",
      cwe: "CWE-89",
      cve: "CVE-2026-1",
      endpoint: "/login",
      method: "POST",
      code_locations: [{ file: "a.py", start_line: 1, end_line: 3, snippet: "x", label: "sink" }],
    }
    expect(normalizeFinding(raw, "run1", 0)).toEqual({
      runId: "run1",
      vulnId: "vuln-0001",
      title: "SQL Injection",
      severity: "high",
      cvss: 8.6,
      description: "found it",
      impact: "rce",
      target: "https://x",
      technicalAnalysis: "root cause",
      pocDescription: "step 1",
      pocScriptCode: "curl x",
      remediationSteps: "parameterize",
      cwe: "CWE-89",
      cve: "CVE-2026-1",
      endpoint: "/login",
      method: "POST",
      codeLocations: [{ file: "a.py", startLine: 1, endLine: 3, snippet: "x", label: "sink" }],
    })
  })

  it("provides fallbacks for missing id/title", () => {
    const f = normalizeFinding({ severity: "low" }, "run1", 4)
    expect(f.vulnId).toBe("vuln-5")
    expect(f.title).toBe("Untitled finding")
    expect(f.severity).toBe("low")
    expect(f.codeLocations).toBeUndefined()
  })
})

describe("parseVulnerabilities", () => {
  it("parses a bare array and sorts most-severe first", () => {
    const json = [
      { id: "a", title: "A", severity: "low" },
      { id: "b", title: "B", severity: "critical" },
      { id: "c", title: "C", severity: "medium" },
    ]
    expect(parseVulnerabilities(json, "r").map((f) => f.severity)).toEqual([
      "critical",
      "medium",
      "low",
    ])
  })

  it("parses a wrapped { vulnerabilities: [...] } object", () => {
    const json = { vulnerabilities: [{ id: "a", title: "A", severity: "high" }] }
    expect(parseVulnerabilities(json, "r")).toHaveLength(1)
  })

  it("skips non-object entries and returns [] for junk", () => {
    expect(
      parseVulnerabilities([null, "x", { id: "a", title: "A", severity: "low" }], "r")
    ).toHaveLength(1)
    expect(parseVulnerabilities(null, "r")).toEqual([])
    expect(parseVulnerabilities(42, "r")).toEqual([])
  })
})

describe("sortBySeverity", () => {
  it("orders critical→info and is stable-ish", () => {
    const findings = [
      { severity: "info" },
      { severity: "critical" },
      { severity: "medium" },
    ] as StrixFinding[]
    expect(sortBySeverity(findings).map((f) => f.severity)).toEqual(["critical", "medium", "info"])
  })
})

describe("parseRunJson", () => {
  it("extracts status", () => {
    expect(parseRunJson({ status: "completed", other: 1 })).toEqual({ status: "completed" })
  })
  it("degrades gracefully", () => {
    expect(parseRunJson(null)).toEqual({ status: undefined })
    expect(parseRunJson("nope")).toEqual({ status: undefined })
  })
})
