import { registerSecurityScanRunController } from "@/lib/execution/control-handlers"
import { syncSecurityScanExecutionRun } from "@/lib/execution/security-scan-bridge"
import type { SecurityScanRunRecord } from "@cognia/plugin-sdk/api/security-findings"

export interface PluginSecurityScansAPI {
  syncExecutionRun(record: SecurityScanRunRecord): Promise<void>
  registerRunController(runId: string, controller: AbortController): () => void
}

export function createSecurityScansAPI(): PluginSecurityScansAPI {
  return {
    syncExecutionRun: syncSecurityScanExecutionRun,
    registerRunController: registerSecurityScanRunController,
  }
}
