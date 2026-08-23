/**
 * Raw scanner artifact → canonical {@link ScanReport}.
 *
 * Shared by the desktop plugin and the CLI so a finding cannot mean one thing
 * on screen and another in CI. Everything is defensive: an unexpected field
 * shape degrades to absent rather than throwing, because a malformed report
 * must still produce a readable answer.
 *
 * The one thing that is NOT defensive is the top-level parse. A payload that
 * is not a recognisable report becomes `completeness: "unreadable"`, never an
 * empty finding list — see {@link ReportCompleteness}.
 */

import { fingerprintFinding, targetKey } from "./fingerprint"
import { normalizeSeverity } from "./severity"
import type { FindingLocation, ScanReport, SecurityFinding } from "./types"

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function str(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return undefined
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value)
  }
  return undefined
}

function normalizeLocations(raw: Record<string, unknown>): FindingLocation[] {
  const locations: FindingLocation[] = []
  const codeLocations = raw.code_locations ?? raw.codeLocations
  if (Array.isArray(codeLocations)) {
    for (const entry of codeLocations) {
      const record = asRecord(entry)
      if (!record) continue
      const file = str(record.file)
      if (!file) continue
      locations.push({
        file,
        ...(num(record.start_line ?? record.startLine) !== undefined
          ? { startLine: num(record.start_line ?? record.startLine) }
          : {}),
        ...(num(record.end_line ?? record.endLine) !== undefined
          ? { endLine: num(record.end_line ?? record.endLine) }
          : {}),
      })
    }
  }
  const endpoint = str(raw.endpoint)
  if (endpoint) {
    const method = str(raw.method)
    locations.push({ endpoint, ...(method ? { method: method.toUpperCase() } : {}) })
  }
  return locations
}

/**
 * The vulnerability CLASS this finding belongs to.
 *
 * Preference order is deliberate: an explicit rule/type field, then CWE, then
 * the title slug. A scanner id (`raw.id`) is never used — it is per-run, and
 * keying identity on it defeats the entire point of a fingerprint.
 */
export function deriveRuleId(raw: Record<string, unknown>): string {
  const explicit = str(raw.rule_id) ?? str(raw.ruleId) ?? str(raw.type) ?? str(raw.category)
  if (explicit) return explicit.toLowerCase()
  const cwe = str(raw.cwe)
  if (cwe) return cwe.toLowerCase().replace(/\s+/gu, "-")
  const title = str(raw.title)
  if (title) {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
  }
  return "unknown"
}

/** Normalize one raw scanner report entry. */
export function normalizeFinding(raw: Record<string, unknown>): SecurityFinding {
  const ruleId = deriveRuleId(raw)
  const title = str(raw.title) ?? "Untitled finding"
  const locations = normalizeLocations(raw)
  const cvss = num(raw.cvss)
  const description = str(raw.description)
  const remediation = str(raw.remediation_steps) ?? str(raw.remediation)
  const cwe = str(raw.cwe)
  const cve = str(raw.cve)
  return {
    fingerprint: fingerprintFinding({ ruleId, title, locations }),
    ruleId,
    title,
    severity: normalizeSeverity(raw.severity),
    ...(cvss !== undefined ? { cvss } : {}),
    ...(description ? { description } : {}),
    ...(remediation ? { remediation } : {}),
    ...(cwe ? { cwe } : {}),
    ...(cve ? { cve } : {}),
    locations,
  }
}

/** Coerce the shapes a vulnerabilities report is known to take into an array. */
function toReportArray(json: unknown): unknown[] | null {
  if (Array.isArray(json)) return json
  const record = asRecord(json)
  if (!record) return null
  for (const key of ["vulnerabilities", "reports", "findings", "results"]) {
    if (Array.isArray(record[key])) return record[key] as unknown[]
  }
  // A record with none of the known keys is a shape we do not understand. It
  // is NOT an empty report: answering "0 findings" for a payload we failed to
  // recognise is exactly the silent-clean outcome this module exists to avoid.
  return null
}

/** Most-severe first, then by title so equal severities have a stable order. */
export function sortFindings(findings: readonly SecurityFinding[]): SecurityFinding[] {
  const order = ["critical", "high", "medium", "low", "info"]
  return [...findings].sort(
    (left, right) =>
      order.indexOf(left.severity) - order.indexOf(right.severity) ||
      left.title.localeCompare(right.title) ||
      left.fingerprint.localeCompare(right.fingerprint)
  )
}

export interface NormalizeInput {
  target: string
  /** The already-JSON-parsed artifact, or `null` when no artifact existed. */
  report: unknown
  /** Set when reading the artifact itself failed; forces `unreadable`. */
  readError?: string
  tool?: { name: string; version?: string }
}

/**
 * Build a canonical report.
 *
 * Three outcomes, and the difference between them is the whole point:
 *  - `readError` present     → `unreadable` (a scan that may have found
 *                              anything; the caller must not treat it as pass)
 *  - `report` null/undefined → `empty` (the scanner had nothing to report;
 *                              Strix writes no artifact for a clean scan)
 *  - anything else           → `complete`, or `unreadable` if the payload does
 *                              not resolve to a list of findings
 */
export function normalizeReport(input: NormalizeInput): ScanReport {
  const target = targetKey(input.target)
  if (input.readError) {
    return {
      target,
      completeness: "unreadable",
      findings: [],
      unreadableReason: input.readError,
      ...(input.tool ? { tool: input.tool } : {}),
    }
  }
  if (input.report === null || input.report === undefined) {
    return {
      target,
      completeness: "empty",
      findings: [],
      ...(input.tool ? { tool: input.tool } : {}),
    }
  }
  const entries = toReportArray(input.report)
  if (!entries) {
    return {
      target,
      completeness: "unreadable",
      findings: [],
      unreadableReason: "report payload did not contain a recognisable finding list",
      ...(input.tool ? { tool: input.tool } : {}),
    }
  }
  const findings: SecurityFinding[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    const record = asRecord(entry)
    if (!record) continue
    const finding = normalizeFinding(record)
    // Two report entries that fingerprint the same ARE the same finding; the
    // more severe reading of it wins rather than the last one parsed.
    const existing = seen.has(finding.fingerprint)
    if (!existing) {
      seen.add(finding.fingerprint)
      findings.push(finding)
      continue
    }
    const index = findings.findIndex((candidate) => candidate.fingerprint === finding.fingerprint)
    const order = ["critical", "high", "medium", "low", "info"]
    if (order.indexOf(finding.severity) < order.indexOf(findings[index].severity)) {
      findings[index] = finding
    }
  }
  return {
    target,
    completeness: "complete",
    findings: sortFindings(findings),
    ...(input.tool ? { tool: input.tool } : {}),
  }
}
