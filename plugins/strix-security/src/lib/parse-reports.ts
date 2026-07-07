// Normalize Strix's on-disk report artifacts into our typed domain objects.
//
//  - vulnerabilities.json — a list of vulnerability reports (snake_case fields).
//  - run.json             — run metadata (we only need `status`).
//
// Everything is defensive: fields are optional, unknown shapes degrade to
// empty rather than throwing, so a malformed report never crashes the panel.

import type { CodeLocation, Severity, StrixFinding } from "../types"
import { SEVERITY_ORDER } from "../types"

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function str(v: unknown): string | undefined {
  if (typeof v === "string") return v
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  return undefined
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v)
  return undefined
}

export function normSeverity(v: unknown): Severity {
  const s = String(v ?? "")
    .toLowerCase()
    .trim()
  return (SEVERITY_ORDER as readonly string[]).includes(s) ? (s as Severity) : "info"
}

function normCodeLocations(v: unknown): CodeLocation[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: CodeLocation[] = []
  for (const raw of v) {
    const r = asRecord(raw)
    if (!r) continue
    out.push({
      file: str(r.file),
      startLine: num(r.start_line),
      endLine: num(r.end_line),
      snippet: str(r.snippet),
      label: str(r.label),
    })
  }
  return out.length ? out : undefined
}

/** Normalize one raw Strix vulnerability report → StrixFinding. */
export function normalizeFinding(
  raw: Record<string, unknown>,
  runId: string,
  index: number
): StrixFinding {
  return {
    runId,
    vulnId: str(raw.id) ?? `vuln-${index + 1}`,
    title: str(raw.title) ?? "Untitled finding",
    severity: normSeverity(raw.severity),
    cvss: num(raw.cvss),
    description: str(raw.description),
    impact: str(raw.impact),
    target: str(raw.target),
    technicalAnalysis: str(raw.technical_analysis),
    pocDescription: str(raw.poc_description),
    pocScriptCode: str(raw.poc_script_code),
    remediationSteps: str(raw.remediation_steps),
    cwe: str(raw.cwe),
    cve: str(raw.cve),
    endpoint: str(raw.endpoint),
    method: str(raw.method),
    codeLocations: normCodeLocations(raw.code_locations),
  }
}

/** Coerce the various vulnerabilities.json shapes into a raw report array. */
function toReportArray(json: unknown): unknown[] {
  if (Array.isArray(json)) return json
  const r = asRecord(json)
  if (!r) return []
  for (const key of ["vulnerabilities", "reports", "findings"]) {
    if (Array.isArray(r[key])) return r[key] as unknown[]
  }
  return []
}

/** Parse vulnerabilities.json → sorted (most-severe first) findings. */
export function parseVulnerabilities(json: unknown, runId: string): StrixFinding[] {
  const findings = toReportArray(json)
    .map((raw, i) => {
      const r = asRecord(raw)
      return r ? normalizeFinding(r, runId, i) : null
    })
    .filter((f): f is StrixFinding => f !== null)
  return sortBySeverity(findings)
}

export function sortBySeverity(findings: StrixFinding[]): StrixFinding[] {
  const rank = (s: Severity) => SEVERITY_ORDER.indexOf(s)
  return [...findings].sort((a, b) => rank(a.severity) - rank(b.severity))
}

export interface RunMeta {
  status?: string
}

/** Parse run.json — only the fields we consume. */
export function parseRunJson(json: unknown): RunMeta {
  const r = asRecord(json)
  return { status: r ? str(r.status) : undefined }
}
