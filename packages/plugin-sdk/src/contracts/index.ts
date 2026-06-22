/**
 * Plugin SDK — `contracts` subpath.
 *
 * Public read-only metadata for plugin capability and point governance. Plugin
 * authors, package tooling, and readiness checks can inspect what the host
 * currently supports without importing from `lib/plugin/contracts/*`.
 */

export {
  CANONICAL_PLUGIN_CAPABILITIES,
  PLUGIN_CAPABILITY_CONTRACTS,
  auditPluginCapabilityContracts,
  getPluginCapabilityContract,
  validatePluginCapabilities,
} from "@/lib/plugin/contracts/plugin-capabilities"

export type {
  PluginCapabilityContract,
  PluginCapabilityDiagnostic,
  PluginCapabilityProofAudit,
  PluginCapabilitySupport,
  PluginCapabilityValidationOutcome,
  PluginContractProofStatus,
} from "@/lib/plugin/contracts/plugin-capabilities"

export {
  getAllContributions,
  getContributionsForCapability,
} from "@/lib/plugin/contracts/capability-contributions"

export type {
  CapabilityContribution,
  CapabilityEntry,
} from "@/lib/plugin/contracts/capability-contributions"

export {
  CANONICAL_ACTIVATION_PATTERNS,
  CANONICAL_EXTENSION_POINTS,
  CANONICAL_HOOK_POINTS,
  CANONICAL_RUNTIME_POINTS,
  DEPRECATED_HOOK_POINTS,
  PLUGIN_POINT_CONTRACTS,
  auditPluginPointContracts,
  getActivationPatternContract,
  getExtensionPointAliases,
  getExtensionPointContract,
  getHookPointContract,
  getRuntimePointContract,
  resolveActivationPattern,
  validateActivationEvent,
  validateExtensionPoint,
  validateHookPoint,
} from "@/lib/plugin/contracts/plugin-points"

export type {
  ActivationEventDeclaration,
  CanonicalActivationPattern,
  CanonicalExtensionPoint,
  CanonicalHookPoint,
  CanonicalRuntimePoint,
  DeprecatedHookPoint,
  PluginPointContract,
  PluginPointDiagnostic,
  PluginPointGovernanceMode,
  PluginPointHostKind,
  PluginPointKind,
  PluginPointProofAudit,
  PluginPointStability,
  PluginPointStatus,
  PluginPointValidationOutcome,
} from "@/lib/plugin/contracts/plugin-points"

export { auditPluginRuntimeClaims } from "@/lib/plugin/contracts/runtime-proof-audit"
export type {
  PluginRuntimeClaimsAuditReport,
  PluginRuntimeRiskAudit,
} from "@/lib/plugin/contracts/runtime-proof-audit"
