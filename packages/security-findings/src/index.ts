/**
 * @cognia/security-findings — the shared core behind the Strix desktop panel
 * and the `cognia-agent security` CLI.
 *
 * Pure data transformation: no Dexie, no Tauri, no filesystem, no crypto
 * module, no network. That is what lets one definition of "a finding" serve
 * both the panel a person reads and the exit code a pipeline acts on.
 */

export {
  SEVERITY_ORDER,
  atOrAboveSeverity,
  countBySeverity,
  isSeverity,
  normalizeSeverity,
  severityRank,
  type Severity,
} from "./severity"

export type { FindingLocation, ReportCompleteness, ScanReport, SecurityFinding } from "./types"

export {
  deriveRuleId,
  normalizeFinding,
  normalizeReport,
  sortFindings,
  type NormalizeInput,
} from "./normalize"

export {
  findingKey,
  fingerprintFinding,
  primaryLocationKey,
  targetKey,
  type FingerprintInput,
} from "./fingerprint"

export {
  baselineStateOf,
  compareToBaseline,
  type BaselineComparison,
  type BaselineState,
} from "./baseline"

export {
  FINGERPRINT_KEY,
  SARIF_SCHEMA,
  SARIF_VERSION,
  baselineFingerprintsFromSarif,
  sarifLevel,
  toSarifLog,
  type SarifLevel,
  type SarifLog,
  type SarifOptions,
} from "./sarif"

export {
  evaluateGate,
  type GateOptions,
  type GateResult,
  type GateVerdict,
  type SecurityExitCode,
} from "./gate"
