// Re-export shim: canonical source moved to @cognia/provider-core (Stage 2).
export {
  buildBuiltInSettingsFromCustomProvider,
  findEquivalentBuiltInProviderCandidates,
  resolveEquivalentBuiltInProviderId,
} from "@cognia/provider-core/providers/built-in-provider-compatibility"
export type {
  EquivalentBuiltInProviderCandidate,
  EquivalentCustomProviderLike,
} from "@cognia/provider-core/providers/built-in-provider-compatibility"
