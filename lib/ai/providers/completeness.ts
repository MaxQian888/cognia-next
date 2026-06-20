// Re-export shim: canonical source moved to @cognia/provider-core (Stage 2).
export {
  buildProviderVerificationFingerprint,
  evaluateBuiltInProviderCompleteness,
  evaluateCustomProviderCompleteness,
  evaluateRuntimeEligibility,
  getActiveCredential,
  getProviderRequirements,
  hasAnyCredential,
  isValidHttpUrl,
} from "@cognia/provider-core/providers/completeness"
export type {
  BuiltInProviderCompleteness,
  CustomProviderCompleteness,
  LatestConnectivityResult,
  ProviderGuardCode,
  ProviderGuardResult,
  ProviderNextAction,
  ProviderReadinessState,
  ProviderRequirements,
  ProviderSetupChecklist,
  ProviderSetupChecklistStep,
  ProviderSetupChecklistStepId,
} from "@cognia/provider-core/providers/completeness"
