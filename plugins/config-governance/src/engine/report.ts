/**
 * The audit and adherence results as markdown, for the `/governance` command
 * and the agent tools (ADR-0238 §12). The report carries the prompt-audit
 * fields per finding — location, evidence, pattern, why, confidence, action —
 * and never a surface's text beyond the quoted evidence.
 */

import { followRate, verdictOf, type CheckResult } from "../adherence/backtest"
import type { RuleCheck } from "../adherence/checks"
import type { AuditRun, Finding } from "../model"

export type Translate = (key: string, params?: Record<string, string | number>) => string

/** Findings listed in a report; the view shows the rest. */
export const REPORT_FINDINGS = 25

function location(run: AuditRun, finding: Finding): string {
  const name =
    run.surfaces.find((entry) => entry.surface.key === finding.location.surfaceKey)?.surface.name ??
    finding.location.surfaceKey
  const { startLine, endLine } = finding.location
  if (startLine === undefined) return name
  return endLine !== undefined && endLine !== startLine
    ? `${name}:${startLine}-${endLine}`
    : `${name}:${startLine}`
}

function quote(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > 160 ? `${flat.slice(0, 157)}…` : flat
}

export function renderAuditReport(
  run: AuditRun,
  t: Translate,
  kept: ReadonlySet<string> = new Set()
): string {
  const findings = run.findings.filter((finding) => !kept.has(finding.id))
  const high = findings.filter((finding) => finding.confidence === "high").length
  const lines = [
    `## ${t("report.auditTitle")}`,
    "",
    t("report.auditSummary", {
      surfaces: run.surfaces.length,
      findings: findings.length,
      high,
      hunks: run.hunks.filter((hunk) => !kept.has(hunk.findingId)).length,
      model: run.targetModel,
    }),
  ]
  if (run.failedSources.length > 0) {
    lines.push("", t("report.failedSources", { sources: run.failedSources.join(", ") }))
  }
  if (findings.length === 0) {
    lines.push("", t("report.noFindings"))
    return lines.join("\n")
  }
  lines.push("")
  for (const finding of findings.slice(0, REPORT_FINDINGS)) {
    lines.push(
      `- **${finding.id}** · ${t(`pattern.${finding.pattern}`)} · ${t(`confidence.${finding.confidence}`)} · ${t(`action.${finding.action}`)}`,
      `  ${location(run, finding)} — “${quote(finding.evidence)}”`,
      ...(finding.reason ? [`  ${quote(finding.reason)}`] : [])
    )
  }
  if (findings.length > REPORT_FINDINGS) {
    lines.push("", t("report.more", { count: findings.length - REPORT_FINDINGS }))
  }
  return lines.join("\n")
}

function percent(value: number | undefined): string {
  return value === undefined ? "—" : `${Math.round(value * 100)}%`
}

export function renderAdherenceReport(
  checks: readonly RuleCheck[],
  results: readonly CheckResult[],
  sessions: number,
  t: Translate
): string {
  const byId = new Map(results.map((result) => [result.checkId, result]))
  const lines = [
    `## ${t("report.adherenceTitle")}`,
    "",
    t("report.adherenceSummary", { checks: checks.length, sessions }),
  ]
  if (checks.length === 0) {
    lines.push("", t("report.noChecks"))
    return lines.join("\n")
  }
  lines.push("")
  for (const check of checks) {
    const result = byId.get(check.id)
    if (!result) continue
    lines.push(
      `- ${t(`verdict.${verdictOf(check, result)}`)} · ${percent(followRate(result))} (${result.followed}/${result.opportunities}) — ${quote(check.summary)}`,
      `  ${check.rule.surfaceName}:${check.rule.startLine}`
    )
  }
  return lines.join("\n")
}
