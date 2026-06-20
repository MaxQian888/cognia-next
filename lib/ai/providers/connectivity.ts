// Re-export shim: canonical source moved to @cognia/provider-core (Stage 2).
export {
  deriveVerificationStatusFromConnectivityResult,
  resolveBuiltInProviderConnectivityTarget,
  resolveCustomProviderConnectivityTarget,
} from "@cognia/provider-core/providers/connectivity"
export type {
  CustomProviderConnectivityInput,
  ProviderConnectivityOutcome,
  ProviderConnectivityProtocol,
  ProviderConnectivityResultLike,
  ProviderConnectivityTarget,
} from "@cognia/provider-core/providers/connectivity"
