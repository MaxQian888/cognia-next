import {
  auditPluginCapabilityContracts,
  type PluginContractProofStatus,
} from "./plugin-capabilities"
import { auditPluginPointContracts } from "./plugin-points"

export interface PluginRuntimeRiskAudit {
  id: string
  area: "lifecycle" | "marketplace"
  description: string
  codePaths: readonly string[]
  evidence: readonly string[]
  proofStatus: PluginContractProofStatus
}

export interface PluginRuntimeClaimsAuditReport {
  capabilities: ReturnType<typeof auditPluginCapabilityContracts>
  points: ReturnType<typeof auditPluginPointContracts>
  runtimeRisks: PluginRuntimeRiskAudit[]
}

// Both previously-tracked optimistic runtime paths have been closed against
// the current code, so this ledger is now empty:
//
//   - plugin-store.status-projection-fallback — resolved. The lifecycle store
//     `stores/plugin-runtime/plugin-store.ts` now routes every manager-backed
//     action through `resolveVerifiedPluginManager`, which throws when no
//     initialized PluginManager is present. The old "project a terminal status
//     locally when execution is unavailable" fallback no longer exists (and its
//     cited path `stores/plugin/plugin-store.ts` never did).
//   - plugin-marketplace.fallback-mock — resolved. The `mock` source mode was
//     replaced by a typed `MarketplaceSourceMode = "remote" | "degraded" |
//     "demo"` in `stores/plugin-runtime/plugin-marketplace-store.ts`, and any
//     non-remote mode is disclosed to the user via `<PluginMarketplaceModeBanner />`
//     (`components/plugins/marketplace/plugin-marketplace.tsx`) plus recorded
//     diagnostics — so non-verified inventory is no longer silently presented
//     as available.
//
// New optimistic paths that lack executable proof should be added back here.
const RUNTIME_RISK_AUDITS: readonly PluginRuntimeRiskAudit[] = []

export function auditPluginRuntimeClaims(): PluginRuntimeClaimsAuditReport {
  return {
    capabilities: auditPluginCapabilityContracts(),
    points: auditPluginPointContracts(),
    runtimeRisks: [...RUNTIME_RISK_AUDITS],
  }
}
