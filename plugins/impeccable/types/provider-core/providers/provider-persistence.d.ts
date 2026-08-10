import {
  ResolverProtocol,
  UserProviderSettings,
  ApiFlavor,
  CustomProviderSettings,
} from "@cognia/provider-types"
export { ResolverProtocol } from "@cognia/provider-types"
import { BuiltInProviderId } from "@cognia/provider-types/built-in-provider-catalog"
import {
  EquivalentCustomProviderLike,
  EquivalentBuiltInProviderCandidate,
} from "./built-in-provider-compatibility.js"

interface ProviderSettingsEntry {
  enabled?: boolean
  apiKey?: string
  baseURL?: string
  /** OpenAI endpoint family override (responses/chat/auto); omitted = auto. */
  apiFlavor?: ApiFlavor
  defaultModel?: string
  options?: Record<string, unknown>
}

interface CustomProviderDefinition {
  id: string
  name: string
  protocol?: ResolverProtocol
  baseURL?: string
  apiKey?: string
  defaultModel?: string
  models?: Array<{
    id: string
    name?: string
    contextLength?: number
  }>
}
interface RichCustomProviderEntry {
  id: string
  protocol?: ResolverProtocol
  apiProtocol?: "openai" | "anthropic" | "gemini" | (string & {})
  baseURL?: string
  apiKey?: string
  defaultModel?: string
}
interface ProviderSettingsSnapshotInput {
  defaultProvider: string | undefined
  providerSettings: Record<string, ProviderSettingsEntry> | undefined
  customProviders: RichCustomProviderEntry[] | undefined
}
interface ProviderSettingsSnapshotSource {
  defaultProvider?: string
  providerSettings?: Record<string, ProviderSettingsEntry>
  customProviders?: RichCustomProviderEntry[]
}
type PersistedProviderSettingsRecord = Record<string, Partial<UserProviderSettings> | undefined>
type PersistedCustomProviderRecord<TCustomProvider extends EquivalentCustomProviderLike> = Record<
  string,
  TCustomProvider | undefined
>
interface NormalizedProviderPersistenceState<TCustomProvider extends EquivalentCustomProviderLike> {
  providerSettings: Record<string, UserProviderSettings>
  customProviders: Record<string, TCustomProvider>
  equivalentBuiltInProviders: Partial<Record<BuiltInProviderId, EquivalentBuiltInProviderCandidate>>
}
declare function normalizeProviderPersistenceState<
  TCustomProvider extends EquivalentCustomProviderLike,
>(input: {
  providerSettings?: PersistedProviderSettingsRecord
  customProviders?: PersistedCustomProviderRecord<TCustomProvider>
}): NormalizedProviderPersistenceState<TCustomProvider>
/**
 * Map a `UserProviderSettings` row to the lean `ProviderSettingsEntry` the
 * plugin / embedding resolver consumes (`lib/ai/provider-consumption.ts`).
 * The two types coexist: the UI writes the rich one; downstream code reads
 * the trimmed one.
 */
declare function toProviderSettingsEntry(
  settings: UserProviderSettings | undefined
): ProviderSettingsEntry
/**
 * Bridge: project an `AppSettings` blob (cognia-next persistence shape)
 * into the snapshot input the resolver in `lib/ai/provider-consumption.ts`
 * consumes. Used by chat hooks, embedding callers, and plugin AI surface.
 *
 * The cognia-next store stores `providerSettings` as
 * `Record<string, ProviderSettingsEntry>` directly (the resolver-facing
 * shape). Custom providers are stored as `CustomProviderDefinition[]`.
 * This bridge is a near-identity mapping; it exists so callers don't need
 * to know which store fields are load-bearing.
 */
declare function buildProviderSnapshotFromSettings(
  settings: ProviderSettingsSnapshotSource | null
): ProviderSettingsSnapshotInput
/**
 * Map the rich `UserProviderSettings` map (used by the new providers UI)
 * down to a `ProviderSettingsEntry` map for the resolver. Pair with
 * `customSettingsToDefinitions` when the UI also stores
 * `CustomProviderSettings[]`.
 */
declare function userSettingsMapToEntries(
  rich: Record<string, UserProviderSettings>
): Record<string, ProviderSettingsEntry>
declare function customSettingsToDefinitions(
  rich: CustomProviderSettings[]
): CustomProviderDefinition[]

export {
  type CustomProviderDefinition,
  type NormalizedProviderPersistenceState,
  type PersistedCustomProviderRecord,
  type PersistedProviderSettingsRecord,
  type ProviderSettingsEntry,
  type ProviderSettingsSnapshotInput,
  type ProviderSettingsSnapshotSource,
  type RichCustomProviderEntry,
  buildProviderSnapshotFromSettings,
  customSettingsToDefinitions,
  normalizeProviderPersistenceState,
  toProviderSettingsEntry,
  userSettingsMapToEntries,
}
