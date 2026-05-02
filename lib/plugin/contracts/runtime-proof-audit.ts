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

const RUNTIME_RISK_AUDITS: readonly PluginRuntimeRiskAudit[] = [
  {
    id: "plugin-store.status-projection-fallback",
    area: "lifecycle",
    description:
      "Store lifecycle actions still project terminal plugin status locally when manager-backed execution is unavailable.",
    codePaths: ["stores/plugin/plugin-store.ts"],
    evidence: ["lib/plugin/core/manager.test.ts"],
    proofStatus: "missing_proof",
  },
  {
    id: "plugin-marketplace.fallback-mock",
    area: "marketplace",
    description:
      "Marketplace discovery can still enter a fallback-mock source mode that risks presenting non-verified inventory as available.",
    codePaths: [
      "stores/plugin/plugin-marketplace-store.ts",
      "components/plugin/marketplace/plugin-marketplace.tsx",
    ],
    evidence: [
      "openspec/changes/improve-existing-plugin-system-end-to-end-validity/specs/plugin-marketplace-experience/spec.md",
    ],
    proofStatus: "missing_proof",
  },
] as const

export function auditPluginRuntimeClaims(): PluginRuntimeClaimsAuditReport {
  return {
    capabilities: auditPluginCapabilityContracts(),
    points: auditPluginPointContracts(),
    runtimeRisks: [...RUNTIME_RISK_AUDITS],
  }
}
