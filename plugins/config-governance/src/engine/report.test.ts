import type { CheckResult } from "../adherence/backtest"
import type { RuleCheck } from "../adherence/checks"
import type { AuditRun } from "../model"
import { renderAdherenceReport, renderAuditReport, REPORT_FINDINGS } from "./report"

const t = (key: string, params?: Record<string, string | number>) =>
  params
    ? `${key}(${Object.entries(params)
        .map(([k, v]) => `${k}=${v}`)
        .join(",")})`
    : key

function run(findings: number): AuditRun {
  return {
    id: "r",
    workspaceId: "w",
    startedAt: 0,
    finishedAt: 1,
    targetModel: "m",
    surfaces: [
      {
        surface: { key: "k", name: "CLAUDE.md" } as AuditRun["surfaces"][number]["surface"],
        textHash: "h",
        lineCount: 3,
      },
    ],
    findings: Array.from({ length: findings }, (_, i) => ({
      id: `F${i}`,
      group: "dated-text" as const,
      pattern: "fossil",
      location: { surfaceKey: "k", startLine: i + 1, endLine: i + 2 },
      evidence: "old   rule",
      reason: i === 0 ? "because" : "",
      confidence: "high" as const,
      action: "remove" as const,
      sources: ["judge" as const],
    })),
    hunks: [],
    failedSources: ["skill"],
    notes: [],
  }
}

describe("renderAuditReport", () => {
  it("lists findings with location, evidence and reason, skipping kept ones and capping the list", () => {
    const report = renderAuditReport(run(REPORT_FINDINGS + 2), t, new Set(["F1"]))
    expect(report).toContain("report.auditSummary(surfaces=1,findings=26,high=26,hunks=0,model=m)")
    expect(report).toContain("report.failedSources(sources=skill)")
    expect(report).toContain("CLAUDE.md:1-2 — “old rule”")
    expect(report).toContain("  because")
    expect(report).not.toContain("**F1**")
    expect(report).toContain("report.more(count=1)")
  })

  it("says when there is nothing to change", () => {
    expect(renderAuditReport({ ...run(0), failedSources: [] }, t)).toContain("report.noFindings")
  })
})

describe("renderAdherenceReport", () => {
  const check: RuleCheck = {
    id: "C1",
    kind: "require-after",
    trigger: { family: "edit" },
    expect: { family: "shell", command: "^pnpm test" },
    scope: "turn",
    summary: "Tests after edits",
    rule: {
      surfaceKey: "k",
      surfaceName: "CLAUDE.md",
      startLine: 4,
      endLine: 4,
      text: "Run tests after edits.",
    },
  }
  const result: CheckResult = {
    checkId: "C1",
    sessionsScanned: 3,
    sessionsTriggered: 2,
    opportunities: 4,
    followed: 1,
    violated: 3,
    excluded: 0,
    samples: [],
  }

  it("states the verdict and the rate per check", () => {
    const report = renderAdherenceReport([check], [result], 3, t)
    expect(report).toContain("verdict.not-followed · 25% (1/4) — Tests after edits")
    expect(report).toContain("CLAUDE.md:4")
  })

  it("says when nothing is checkable", () => {
    expect(renderAdherenceReport([], [], 0, t)).toContain("report.noChecks")
  })
})
