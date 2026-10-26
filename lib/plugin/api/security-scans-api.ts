import { registerSecurityScanRunController } from "@/lib/execution/control-handlers"
import { syncSecurityScanExecutionRun } from "@/lib/execution/security-scan-bridge"
import type { PluginSecurityScansAPI } from "@cognia/plugin-contract/lib/plugin/api/security-scans-api"
export type { PluginSecurityScansAPI } from "@cognia/plugin-contract/lib/plugin/api/security-scans-api"

export function createSecurityScansAPI(): PluginSecurityScansAPI {
  return {
    syncExecutionRun: syncSecurityScanExecutionRun,
    registerRunController: registerSecurityScanRunController,
  }
}
