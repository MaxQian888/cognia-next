/**
 * Plugin SDK — `security-findings` capability surface.
 *
 * A security scanner is a natural plugin: the scanners themselves are external
 * tools, and which ones a user trusts is their business. What must NOT be
 * per-plugin is the finding vocabulary — severity normalization, the stable
 * fingerprint that lets the same defect be recognised across two scans, the
 * SARIF projection consumed by CI. Two plugins with private copies of those
 * produce findings that cannot be deduplicated against each other or against
 * the CLI's.
 *
 * So the shared package is re-exported here rather than added to the author
 * package allowlist: it becomes a contract with a documented surface instead of
 * a workspace package a plugin happens to be able to resolve.
 *
 * The execution half — `syncSecurityScanExecutionRun` and
 * `registerSecurityScanRunController` — is what makes a plugin-run scan a
 * first-class run: it shows up in the run cockpit, reports progress, and can be
 * cancelled from the same controls as everything else. A scanner that skips it
 * runs invisibly and cannot be stopped.
 */

export {
  deriveRuleId,
  findingKey,
  fingerprintFinding,
  normalizeSeverity,
  SEVERITY_ORDER,
  targetKey,
  toSarifLog,
} from "@cognia/security-findings"

export type {
  FindingLocation,
  ScanReport,
  SecurityFinding,
  Severity,
} from "@cognia/security-findings"

export {
  securityScanExecutionRunId,
  securityScanRunStatus,
  syncSecurityScanExecutionRun,
} from "@/lib/execution/security-scan-bridge"

export type { SecurityScanRunRecord } from "@/lib/execution/security-scan-bridge"

export { registerSecurityScanRunController } from "@/lib/execution/control-handlers"
