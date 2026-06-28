import type {
  ApiFlavor,
  CustomProviderSettings,
  ResolverProtocol,
  UserProviderSettings,
} from "@cognia/provider-types"
import {
  buildDefaultBuiltInProviderSettings,
  isBuiltInProviderId,
  type BuiltInProviderId,
} from "@cognia/provider-types/built-in-provider-catalog"
import {
  findEquivalentBuiltInProviderCandidates,
  type EquivalentBuiltInProviderCandidate,
  type EquivalentCustomProviderLike,
} from "./built-in-provider-compatibility"

export interface ProviderSettingsEntry {
  enabled?: boolean
  apiKey?: string
  baseURL?: string
  /** OpenAI endpoint family override (responses/chat/auto); omitted = auto. */
  apiFlavor?: ApiFlavor
  defaultModel?: string
  options?: Record<string, unknown>
}

// Single definition lives in `@cognia/provider-types`; re-exported here so
// existing importers of this module keep working.
export type { ResolverProtocol }

export interface CustomProviderDefinition {
  id: string
  name: string
  protocol?: ResolverProtocol
  baseURL?: string
  apiKey?: string
  defaultModel?: string
  models?: Array<{ id: string; name?: string; contextLength?: number }>
}

export interface RichCustomProviderEntry {
  id: string
  protocol?: ResolverProtocol
  apiProtocol?: "openai" | "anthropic" | "gemini" | (string & {})
  baseURL?: string
  apiKey?: string
  defaultModel?: string
}

export interface ProviderSettingsSnapshotInput {
  defaultProvider: string | undefined
  providerSettings: Record<string, ProviderSettingsEntry> | undefined
  customProviders: RichCustomProviderEntry[] | undefined
}

export interface ProviderSettingsSnapshotSource {
  defaultProvider?: string
  providerSettings?: Record<string, ProviderSettingsEntry>
  customProviders?: RichCustomProviderEntry[]
}

export type PersistedProviderSettingsRecord = Record<
  string,
  Partial<UserProviderSettings> | undefined
>

export type PersistedCustomProviderRecord<TCustomProvider extends EquivalentCustomProviderLike> =
  Record<string, TCustomProvider | undefined>

export interface NormalizedProviderPersistenceState<
  TCustomProvider extends EquivalentCustomProviderLike,
> {
  providerSettings: Record<string, UserProviderSettings>
  customProviders: Record<string, TCustomProvider>
  equivalentBuiltInProviders: Partial<Record<BuiltInProviderId, EquivalentBuiltInProviderCandidate>>
}

function normalizeBuiltInProviderSettings(
  persistedProviderSettings?: PersistedProviderSettingsRecord
): Record<string, UserProviderSettings> {
  const defaultSettings = buildDefaultBuiltInProviderSettings()
  const normalizedProviderSettings: Record<string, UserProviderSettings> = {
    ...defaultSettings,
  }

  for (const [providerId, persistedSettings] of Object.entries(persistedProviderSettings || {})) {
    if (!persistedSettings) continue

    const baseSettings = isBuiltInProviderId(providerId)
      ? defaultSettings[providerId]
      : {
          providerId,
          defaultModel: "",
          enabled: false,
        }

    normalizedProviderSettings[providerId] = {
      ...baseSettings,
      ...persistedSettings,
      providerId: persistedSettings.providerId || providerId,
      defaultModel: persistedSettings.defaultModel ?? baseSettings.defaultModel,
      enabled: persistedSettings.enabled ?? baseSettings.enabled,
    }
  }

  return normalizedProviderSettings
}

function normalizeCustomProviders<TCustomProvider extends EquivalentCustomProviderLike>(
  customProviders?: PersistedCustomProviderRecord<TCustomProvider>
): Record<string, TCustomProvider> {
  return Object.fromEntries(
    Object.entries(customProviders || {}).filter((entry): entry is [string, TCustomProvider] =>
      Boolean(entry[1])
    )
  )
}

export function normalizeProviderPersistenceState<
  TCustomProvider extends EquivalentCustomProviderLike,
>(input: {
  providerSettings?: PersistedProviderSettingsRecord
  customProviders?: PersistedCustomProviderRecord<TCustomProvider>
}): NormalizedProviderPersistenceState<TCustomProvider> {
  const providerSettings = normalizeBuiltInProviderSettings(input.providerSettings)
  const customProviders = normalizeCustomProviders(input.customProviders)

  return {
    providerSettings,
    customProviders,
    equivalentBuiltInProviders: findEquivalentBuiltInProviderCandidates(customProviders),
  }
}

/**
 * Map a `UserProviderSettings` row to the lean `ProviderSettingsEntry` the
 * plugin / embedding resolver consumes (`lib/ai/provider-consumption.ts`).
 * The two types coexist: the UI writes the rich one; downstream code reads
 * the trimmed one.
 */
export function toProviderSettingsEntry(
  settings: UserProviderSettings | undefined
): ProviderSettingsEntry {
  if (!settings) return {}
  const out: ProviderSettingsEntry = {
    enabled: settings.enabled,
    apiKey: settings.apiKey,
    baseURL: settings.baseURL,
    defaultModel: settings.defaultModel,
  }
  if (settings.providerSpecificParams || settings.advancedParams) {
    out.options = {
      ...(settings.providerSpecificParams ?? {}),
      ...(settings.advancedParams ?? {}),
    }
  }
  return out
}

function customSettingsToDefinition(custom: CustomProviderSettings): CustomProviderDefinition {
  // Cognia's CustomProviderSettings.apiProtocol is 'openai' | 'anthropic' |
  // 'gemini'; the resolver expects 'openai' | 'anthropic' | 'google' |
  // 'mistral' | 'cohere'. Map gemini → google so the AI SDK client matches.
  const protocol: CustomProviderDefinition["protocol"] =
    custom.apiProtocol === "gemini" ? "google" : custom.apiProtocol
  return {
    id: custom.id,
    name: custom.name,
    protocol,
    baseURL: custom.baseURL,
    apiKey: custom.apiKey,
    defaultModel: custom.defaultModel,
    models: custom.models?.map((id) => ({ id })),
  }
}

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
export function buildProviderSnapshotFromSettings(
  settings: ProviderSettingsSnapshotSource | null
): ProviderSettingsSnapshotInput {
  return {
    defaultProvider: settings?.defaultProvider,
    providerSettings: settings?.providerSettings,
    customProviders: settings?.customProviders,
  }
}

/**
 * Map the rich `UserProviderSettings` map (used by the new providers UI)
 * down to a `ProviderSettingsEntry` map for the resolver. Pair with
 * `customSettingsToDefinitions` when the UI also stores
 * `CustomProviderSettings[]`.
 */
export function userSettingsMapToEntries(
  rich: Record<string, UserProviderSettings>
): Record<string, ProviderSettingsEntry> {
  const out: Record<string, ProviderSettingsEntry> = {}
  for (const [id, settings] of Object.entries(rich)) {
    out[id] = toProviderSettingsEntry(settings)
  }
  return out
}

export function customSettingsToDefinitions(
  rich: CustomProviderSettings[]
): CustomProviderDefinition[] {
  return rich.map(customSettingsToDefinition)
}
