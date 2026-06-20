// Re-export shim: canonical source moved to @cognia/provider-core (Stage 2).
export {
  getActiveCredential,
  getBuiltInProviderReadiness,
  getBuiltinProviderChatRuntimeMessage,
  getChatRuntimeProviderGuard,
  getCustomProviderReadiness,
  getProviderEnableEligibility,
  getVisibleEligibleBuiltInProviderIds,
  getVisibleEligibleCustomProviderIds,
  getVisibleRetryFailedBuiltInProviderIds,
  getVisibleRetryFailedCustomProviderIds,
  getVisibleSelectedProviderIds,
  hasAnyCredential,
} from "@cognia/provider-core/providers/readiness"
export type {
  BuiltInProviderReadiness,
  ChatRuntimeProviderGuard,
  CustomProviderLike,
  CustomProviderReadiness,
  ProviderActionEligibility,
  ProviderNextAction,
  ProviderReadinessState,
  ProviderSetupChecklist,
  ProviderVerificationStatus,
} from "@cognia/provider-core/providers/readiness"
