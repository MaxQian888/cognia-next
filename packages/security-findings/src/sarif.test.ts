import { normalizeReport } from "./normalize"
import {
  FINGERPRINT_KEY,
  SARIF_SCHEMA,
  SARIF_VERSION,
  baselineFingerprintsFromSarif,
  sarifLevel,
  toSarifLog,
} from "./sarif"
import type { ScanReport, SecurityFinding } from "./types"

function finding(over: Partial<SecurityFinding> = {}): SecurityFinding {
  return {
    fingerprint: "fp1",
    ruleId: "sqli",
    title: "SQL injection",
    severity: "critical",
    locations: [{ file: "src/db.ts", startLine: 4, endLine: 9 }],
    ...over,
  }
}

function report(
  findings: SecurityFinding[],
  completeness: ScanReport["completeness"] = "complete"
): ScanReport {
  return { target: "example.com", completeness, findings }
}

describe("sarifLevel", () => {
  it("collapses five severities into SARIF's four levels", () => {
    expect(sarifLevel("critical")).toBe("error")
    expect(sarifLevel("high")).toBe("error")
    expect(sarifLevel("medium")).toBe("warning")
    expect(sarifLevel("low")).toBe("note")
    expect(sarifLevel("info")).toBe("note")
  })
})

describe("toSarifLog", () => {
  it("emits a well-formed 2.1.0 envelope", () => {
    const log = toSarifLog(report([finding()]))
    expect(log.$schema).toBe(SARIF_SCHEMA)
    expect(log.version).toBe(SARIF_VERSION)
    expect(log.runs).toHaveLength(1)
    expect(log.runs[0].tool.driver.name).toBe("cognia-security")
  })

  it("anchors a white-box result to its file and region", () => {
    const log = toSarifLog(report([finding()]))
    expect(log.runs[0].results[0].locations[0]).toEqual({
      physicalLocation: {
        artifactLocation: { uri: "src/db.ts" },
        region: { startLine: 4, endLine: 9 },
      },
    })
  })

  it("omits the region when no line was reported", () => {
    const log = toSarifLog(report([finding({ locations: [{ file: "a.ts" }] })]))
    expect(log.runs[0].results[0].locations[0].physicalLocation.region).toBeUndefined()
  })

  it("anchors a black-box result to its endpoint", () => {
    const log = toSarifLog(
      report([finding({ locations: [{ endpoint: "/login", method: "POST" }] })])
    )
    expect(log.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri).toBe("/login")
  })

  it("keeps a finding that has no location at all", () => {
    const log = toSarifLog(report([finding({ locations: [] })]))
    expect(log.runs[0].results).toHaveLength(1)
    expect(log.runs[0].results[0].locations).toEqual([])
  })

  it("carries the fingerprint so the log can seed the next baseline", () => {
    const log = toSarifLog(report([finding()]))
    expect(log.runs[0].results[0].partialFingerprints).toEqual({ [FINGERPRINT_KEY]: "fp1" })
  })

  it("de-duplicates rules and indexes results into them", () => {
    const log = toSarifLog(
      report([
        finding({ fingerprint: "a", locations: [{ file: "a.ts" }] }),
        finding({ fingerprint: "b", locations: [{ file: "b.ts" }] }),
        finding({ fingerprint: "c", ruleId: "xss", locations: [{ file: "c.ts" }] }),
      ])
    )
    expect(log.runs[0].tool.driver.rules.map((rule) => rule.id)).toEqual(["sqli", "xss"])
    expect(log.runs[0].results.map((result) => result.ruleIndex)).toEqual([0, 0, 1])
  })

  it("emits security-severity and CWE/CVE tags for code-scanning consumers", () => {
    const log = toSarifLog(report([finding({ cwe: "CWE-89", cve: "cve-2024-1" })]))
    const rule = log.runs[0].tool.driver.rules[0]
    expect(rule.properties["security-severity"]).toBe("9.5")
    expect(rule.properties.tags).toEqual(["security", "external/cwe/cwe-89", "CVE-2024-1"])
  })

  it("marks the invocation failed for an unreadable report", () => {
    // The SARIF-native way to say "do not read this as a clean bill of health".
    const log = toSarifLog(report([], "unreadable"))
    expect(log.runs[0].invocations[0].executionSuccessful).toBe(false)
    expect(log.runs[0].results).toEqual([])
  })

  it("marks the invocation successful for a clean scan", () => {
    const log = toSarifLog(report([], "empty"))
    expect(log.runs[0].invocations[0].executionSuccessful).toBe(true)
  })

  it("stamps baselineState only when a baseline was supplied", () => {
    const findings = [
      finding({ fingerprint: "known" }),
      finding({ fingerprint: "fresh", locations: [{ file: "b.ts" }] }),
    ]
    const without = toSarifLog(report(findings))
    expect(without.runs[0].results.every((result) => result.baselineState === undefined)).toBe(true)

    const withBaseline = toSarifLog(report(findings), { baseline: new Set(["known"]) })
    expect(withBaseline.runs[0].results.map((result) => result.baselineState)).toEqual([
      "unchanged",
      "new",
    ])
  })

  it("omits suppressed findings from the log entirely", () => {
    const log = toSarifLog(
      report([
        finding({ fingerprint: "a" }),
        finding({ fingerprint: "b", locations: [{ file: "b.ts" }] }),
      ]),
      { suppressed: new Set(["a"]) }
    )
    expect(
      log.runs[0].results.map((result) => result.partialFingerprints[FINGERPRINT_KEY])
    ).toEqual(["b"])
  })

  it("orders results most severe first", () => {
    const log = toSarifLog(
      report([
        finding({ fingerprint: "low", severity: "low", locations: [{ file: "a.ts" }] }),
        finding({ fingerprint: "crit", severity: "critical", locations: [{ file: "b.ts" }] }),
      ])
    )
    expect(log.runs[0].results.map((result) => result.level)).toEqual(["error", "note"])
  })

  it("prefers explicit tool identity over the report's", () => {
    const withTool: ScanReport = { ...report([]), tool: { name: "strix", version: "1.0" } }
    expect(toSarifLog(withTool).runs[0].tool.driver).toMatchObject({
      name: "strix",
      version: "1.0",
    })
    expect(
      toSarifLog(withTool, { toolName: "override", toolVersion: "9", informationUri: "https://x" })
        .runs[0].tool.driver
    ).toMatchObject({ name: "override", version: "9", informationUri: "https://x" })
  })

  it("normalizes Windows separators in artifact URIs", () => {
    const log = toSarifLog(report([finding({ locations: [{ file: "src\\db.ts" }] })]))
    expect(log.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri).toBe(
      "src/db.ts"
    )
  })
})

describe("baselineFingerprintsFromSarif", () => {
  it("round-trips a log this package emitted", () => {
    const log = toSarifLog(
      report([
        finding({ fingerprint: "a" }),
        finding({ fingerprint: "b", locations: [{ file: "b.ts" }] }),
      ])
    )
    expect(baselineFingerprintsFromSarif(log)).toEqual(new Set(["a", "b"]))
  })

  it("round-trips through JSON, which is how a baseline actually travels", () => {
    const report0 = normalizeReport({
      target: "https://example.com",
      report: [
        { rule_id: "sqli", title: "t", severity: "high", code_locations: [{ file: "a.ts" }] },
      ],
    })
    const parsed = JSON.parse(JSON.stringify(toSarifLog(report0)))
    expect(baselineFingerprintsFromSarif(parsed)).toEqual(
      new Set([report0.findings[0].fingerprint])
    )
  })

  it.each([null, undefined, 42, {}, { runs: "no" }, { runs: [{}] }, { runs: [{ results: 3 }] }])(
    "returns an empty baseline for a log shaped like %p",
    (input) => {
      expect(baselineFingerprintsFromSarif(input)).toEqual(new Set())
    }
  )

  it("ignores results from another tool that carry no fingerprint of ours", () => {
    // An empty baseline over-reports (everything looks new), which is the safe
    // direction; silently trusting a foreign key would under-report.
    const foreign = { runs: [{ results: [{ partialFingerprints: { someOtherTool: "x" } }] }] }
    expect(baselineFingerprintsFromSarif(foreign)).toEqual(new Set())
  })
})
