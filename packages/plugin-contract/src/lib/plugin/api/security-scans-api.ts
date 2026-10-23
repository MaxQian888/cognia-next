/**
 * The plugin contract's share of `lib/plugin/api/security-scans-api.ts`, which re-exports these.
 */
import type { SecurityScanRunRecord } from "@cognia/plugin-sdk/api/security-findings"

export interface PluginSecurityScansAPI {
  syncExecutionRun(record: SecurityScanRunRecord): Promise<void>
  registerRunController(runId: string, controller: AbortController): () => void
}
