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

export interface SecurityScanRunRecord {
  runId: string
  target: string
  startedAt: number
  endedAt?: number
  status: "running" | "done" | "error" | "cancelled"
  findingsCount: number
  reportUnreadable?: boolean
}

export type SecurityScanExecutionStatus = "running" | "completed" | "failed" | "cancelled"

export function securityScanExecutionRunId(sourceRunId: string): string {
  return `execution:security-scan:${sourceRunId}`
}

export function securityScanRunStatus(record: SecurityScanRunRecord): SecurityScanExecutionStatus {
  if (record.status === "running") return "running"
  if (record.status === "cancelled") return "cancelled"
  if (record.status === "error" || record.reportUnreadable) return "failed"
  return "completed"
}

/** Host execution-journal operations are governed through `ctx.securityScans`. */
export type { PluginSecurityScansAPI } from "@/lib/plugin/api/security-scans-api"
