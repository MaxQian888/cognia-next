import type {
  CreatePluginVerificationSnapshotInput,
  PluginVerificationSnapshot,
} from "@/types/plugin"
import { getPluginCapabilityContract } from "@/lib/plugin/contracts/plugin-capabilities"

export interface CapabilityRuntimeProof {
  support: "supported"
  requiredTests: readonly string[]
}

const RUNTIME_PROOF_CAPABILITIES = new Set(["media", "canvas", "ai-provider"])

export function collectCapabilityRuntimeProofs(
  capabilities: readonly string[] = []
): Record<string, CapabilityRuntimeProof> {
  return capabilities.reduce<Record<string, CapabilityRuntimeProof>>((proofs, capability) => {
    if (!RUNTIME_PROOF_CAPABILITIES.has(capability)) {
      return proofs
    }

    const contract = getPluginCapabilityContract(capability)
    if (!contract || contract.support !== "supported") {
      return proofs
    }

    proofs[capability] = {
      support: "supported",
      requiredTests: [...contract.requiredTests],
    }
    return proofs
  }, {})
}

export function createPluginVerificationSnapshot(
  input: CreatePluginVerificationSnapshotInput
): PluginVerificationSnapshot {
  const capabilityProofs = collectCapabilityRuntimeProofs(input.declaredCapabilities || [])
  const metadata =
    Object.keys(capabilityProofs).length > 0
      ? {
          ...(input.metadata || {}),
          capabilityProofs,
        }
      : input.metadata

  return {
    pluginId: input.pluginId,
    source: input.source,
    installRootKind: input.installRootKind,
    status: input.status,
    verificationStage: input.verificationStage,
    lastVerifiedAction: input.lastVerifiedAction,
    lastVerifiedAt: input.verifiedAt,
    lastSuccessfulAt: input.successful ? input.verifiedAt : input.lastSuccessfulAt,
    lastFailureAt: input.successful ? undefined : input.verifiedAt,
    resolvedVersion: input.resolvedVersion,
    diagnostics: (input.diagnostics || []).map((diagnostic) => ({
      ...diagnostic,
      stage: diagnostic.stage || input.verificationStage,
    })),
    metadata,
  }
}
