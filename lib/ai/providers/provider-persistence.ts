// Re-export shim: canonical source moved to @cognia/provider-core (Stage 2).
export {
  buildProviderSnapshotFromSettings,
  customSettingsToDefinitions,
  normalizeProviderPersistenceState,
  toProviderSettingsEntry,
  userSettingsMapToEntries,
} from "@cognia/provider-core/providers/provider-persistence"
export type {
  NormalizedProviderPersistenceState,
  PersistedCustomProviderRecord,
  PersistedProviderSettingsRecord,
} from "@cognia/provider-core/providers/provider-persistence"
