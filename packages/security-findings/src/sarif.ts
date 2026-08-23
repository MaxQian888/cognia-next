/**
 * SARIF 2.1.0 emit and baseline read-back.
 *
 * SARIF is the interchange format every code-scanning consumer already speaks
 * (GitHub code scanning, Azure DevOps, most IDE viewers), which is why the
 * export target is SARIF rather than a Cognia-shaped JSON nobody else reads.
 *
 * Only the subset this product can honestly populate is emitted. Notably
 * absent: `artifacts`, `codeFlows`, `graphs`, `fixes`, and `automationDetails`
 * — a scanner report gives no basis for any of them, and inventing empty
 * scaffolding would make the log look richer than the data behind it.
 */

import { baselineStateOf, type BaselineState } from "./baseline"
import { severityRank } from "./severity"
import type { Severity } from "./severity"
import type { ScanReport, SecurityFinding } from "./types"

/**
 * `partialFingerprints` key carrying our identity.
 *
 * Namespaced so a consumer merging logs from several tools cannot collide with
 * another tool's fingerprint, and versioned so a future change to the
 * fingerprint derivation can be introduced without silently invalidating every
 * baseline in existence — a reader that finds only `v1` keys knows why.
 */
export const FINGERPRINT_KEY = "cogniaSecurityFindingV1"

export const SARIF_SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json"
export const SARIF_VERSION = "2.1.0"

export type SarifLevel = "error" | "warning" | "note" | "none"

/**
 * Severity → SARIF level.
 *
 * SARIF has four levels and this product has five severities, so the mapping
 * is lossy by construction; `security-severity` below carries the original
 * precision for consumers that read it.
 */
export function sarifLevel(severity: Severity): SarifLevel {
  if (severity === "critical" || severity === "high") return "error"
  if (severity === "medium") return "warning"
  return "note"
}

/**
 * GitHub code scanning reads `security-severity` as a numeric string and
 * derives its own buckets from it. These are the thresholds it documents:
 * 9.0+ critical, 7.0+ high, 4.0+ medium, 0.1+ low.
 */
const SECURITY_SEVERITY: Readonly<Record<Severity, string>> = Object.freeze({
  critical: "9.5",
  high: "7.5",
  medium: "5.0",
  low: "2.0",
  info: "0.0",
})

export interface SarifLog {
  $schema: string
  version: string
  runs: SarifRun[]
}

interface SarifRun {
  tool: { driver: SarifDriver }
  results: SarifResult[]
  invocations: Array<{ executionSuccessful: boolean; toolExecutionNotifications?: unknown[] }>
}

interface SarifDriver {
  name: string
  version?: string
  informationUri?: string
  rules: SarifRule[]
}

interface SarifRule {
  id: string
  name: string
  shortDescription: { text: string }
  fullDescription?: { text: string }
  help?: { text: string }
  properties: { "security-severity": string; tags: string[] }
}

interface SarifResult {
  ruleId: string
  ruleIndex: number
  level: SarifLevel
  message: { text: string }
  locations: SarifLocation[]
  partialFingerprints: Record<string, string>
  baselineState?: BaselineState
}

interface SarifLocation {
  physicalLocation: {
    artifactLocation: { uri: string }
    region?: { startLine: number; endLine?: number }
  }
}

function ruleFor(finding: SecurityFinding): SarifRule {
  const tags = ["security"]
  if (finding.cwe) tags.push(`external/cwe/${finding.cwe.toLowerCase().replace(/\s+/gu, "-")}`)
  if (finding.cve) tags.push(finding.cve.toUpperCase())
  return {
    id: finding.ruleId,
    name: finding.ruleId,
    shortDescription: { text: finding.title },
    ...(finding.description ? { fullDescription: { text: finding.description } } : {}),
    ...(finding.remediation ? { help: { text: finding.remediation } } : {}),
    properties: { "security-severity": SECURITY_SEVERITY[finding.severity], tags },
  }
}

function locationsFor(finding: SecurityFinding): SarifLocation[] {
  const locations: SarifLocation[] = []
  for (const location of finding.locations) {
    if (location.file) {
      locations.push({
        physicalLocation: {
          artifactLocation: { uri: location.file.replaceAll("\\", "/") },
          ...(location.startLine !== undefined
            ? {
                region: {
                  startLine: location.startLine,
                  ...(location.endLine !== undefined ? { endLine: location.endLine } : {}),
                },
              }
            : {}),
        },
      })
      continue
    }
    if (location.endpoint) {
      locations.push({ physicalLocation: { artifactLocation: { uri: location.endpoint } } })
    }
  }
  // SARIF requires at least a location to anchor a result in most viewers. A
  // finding with none is anchored to the target itself rather than dropped —
  // silently discarding a finding because it lacks a file is the failure mode
  // this whole package is built to avoid.
  return locations
}

export interface SarifOptions {
  toolName?: string
  toolVersion?: string
  informationUri?: string
  /** Baseline fingerprints; enables `baselineState` on every result. */
  baseline?: ReadonlySet<string>
  /** Fingerprints to omit from the log entirely (triaged as not-a-problem). */
  suppressed?: ReadonlySet<string>
}

/** Build a SARIF 2.1.0 log from a normalized report. */
export function toSarifLog(report: ScanReport, options: SarifOptions = {}): SarifLog {
  const suppressed = options.suppressed
  const findings = report.findings
    .filter((finding) => !suppressed?.has(finding.fingerprint))
    .slice()
    .sort((left, right) => severityRank(left.severity) - severityRank(right.severity))

  const ruleIndex = new Map<string, number>()
  const rules: SarifRule[] = []
  const results: SarifResult[] = []

  for (const finding of findings) {
    let index = ruleIndex.get(finding.ruleId)
    if (index === undefined) {
      index = rules.length
      ruleIndex.set(finding.ruleId, index)
      rules.push(ruleFor(finding))
    }
    const state = baselineStateOf(finding, options.baseline)
    results.push({
      ruleId: finding.ruleId,
      ruleIndex: index,
      level: sarifLevel(finding.severity),
      message: { text: finding.title },
      locations: locationsFor(finding),
      partialFingerprints: { [FINGERPRINT_KEY]: finding.fingerprint },
      ...(state ? { baselineState: state } : {}),
    })
  }

  return {
    $schema: SARIF_SCHEMA,
    version: SARIF_VERSION,
    runs: [
      {
        tool: {
          driver: {
            name: options.toolName ?? report.tool?.name ?? "cognia-security",
            ...((options.toolVersion ?? report.tool?.version)
              ? { version: options.toolVersion ?? report.tool?.version }
              : {}),
            ...(options.informationUri ? { informationUri: options.informationUri } : {}),
            rules,
          },
        },
        results,
        // The SARIF-native way to say "do not read this run as a clean bill of
        // health". A consumer that ingests an unreadable report must see the
        // run itself marked failed, not an empty result list.
        invocations: [{ executionSuccessful: report.completeness !== "unreadable" }],
      },
    ],
  }
}

/**
 * Read fingerprints back out of a SARIF log, for use as a baseline.
 *
 * Tolerant of any log shape: a result without our `partialFingerprints` key
 * contributes nothing rather than throwing, so a SARIF file produced by
 * another tool yields an empty baseline instead of an error. That is the safe
 * direction — an empty baseline reports everything as new, which over-reports
 * rather than under-reports.
 */
export function baselineFingerprintsFromSarif(log: unknown): Set<string> {
  const fingerprints = new Set<string>()
  const runs = (log as { runs?: unknown })?.runs
  if (!Array.isArray(runs)) return fingerprints
  for (const run of runs) {
    const results = (run as { results?: unknown })?.results
    if (!Array.isArray(results)) continue
    for (const result of results) {
      const partial = (result as { partialFingerprints?: unknown })?.partialFingerprints
      if (!partial || typeof partial !== "object") continue
      const value = (partial as Record<string, unknown>)[FINGERPRINT_KEY]
      if (typeof value === "string" && value) fingerprints.add(value)
    }
  }
  return fingerprints
}
