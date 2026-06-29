// Fixture builders for Settings → Provider stories. Each builder fills every
// required field with a realistic default so the object satisfies the
// `@cognia/provider-types` shapes and is valid both as a component `arg` and as
// a `seedStore(useSettingsStore, …)` payload. Spread `over` to vary one field.
import type {
  CustomModelMetadata,
  CustomProviderSettings,
  ModelConfig,
  ProviderModelDiscoveryEntry,
  ProviderModelUsageEntry,
  UserProviderSettings,
} from "@cognia/provider-types/provider"
import type {
  ModelMapping,
  ModelMappingEntry,
  ProviderConstraint,
  RoutingConfig,
} from "@cognia/provider-types/model-mapping"
import { DEFAULT_ROUTING_CONFIG } from "@cognia/provider-types/model-mapping"

let providerSeq = 0
let customSeq = 0
let mappingSeq = 0
let usageSeq = 0

/** A realistic enabled+verified built-in provider config row. */
export function makeUserProviderSettings(
  over: Partial<UserProviderSettings> = {}
): UserProviderSettings {
  providerSeq += 1
  return {
    providerId: `provider-${providerSeq}`,
    apiKey: "sk-test-0123456789abcdef0123456789abcdef",
    defaultModel: "gpt-4.1",
    enabled: true,
    verificationStatus: "verified",
    lastVerifiedAt: Date.UTC(2026, 5, 20, 9, 0, 0),
    healthStatus: "healthy",
    enabledModels: ["gpt-4.1", "gpt-4.1-mini"],
    ...over,
  }
}

/** A fully-populated custom (user-defined) provider row. */
export function makeCustomProviderSettings(
  over: Partial<CustomProviderSettings> = {}
): CustomProviderSettings {
  customSeq += 1
  const id = over.id ?? `custom-${customSeq}`
  const customModels = over.customModels ?? ["custom-large", "custom-small"]
  return {
    providerId: id,
    id,
    isCustom: true,
    name: `Custom Gateway ${customSeq}`,
    customName: `Custom Gateway ${customSeq}`,
    apiKey: "sk-custom-0123456789abcdef",
    baseURL: "https://gateway.example.com/v1",
    apiProtocol: "openai",
    defaultModel: customModels[0] ?? "",
    enabled: true,
    customModels,
    models: customModels,
    verificationStatus: "verified",
    ...over,
  }
}

/** A model-list entry (capability flags default to a tool+vision chat model). */
export function makeModelConfig(over: Partial<ModelConfig> = {}): ModelConfig {
  return {
    id: "gpt-4.1",
    name: "GPT-4.1",
    contextLength: 1_000_000,
    maxOutputTokens: 32_768,
    supportsTools: true,
    supportsVision: true,
    supportsAudio: false,
    supportsVideo: false,
    supportsStreaming: true,
    pricing: { promptPer1M: 2, completionPer1M: 8 },
    ...over,
  }
}

/** A discovered (live `/models`) entry as persisted on a provider config. */
export function makeDiscoveredModel(
  over: Partial<ProviderModelDiscoveryEntry> = {}
): ProviderModelDiscoveryEntry {
  return {
    id: "gpt-4.1",
    name: "GPT-4.1",
    contextLength: 1_000_000,
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    pricing: { promptPer1M: 2, completionPer1M: 8 },
    ...over,
  }
}

/** Per-model capability/pricing override for a custom provider. */
export function makeCustomModelMetadata(
  over: Partial<CustomModelMetadata> = {}
): CustomModelMetadata {
  return {
    id: "custom-large",
    name: "Custom Large",
    contextLength: 128_000,
    maxOutputTokens: 16_384,
    pricing: { promptPer1M: 1.5, completionPer1M: 6 },
    capabilities: { vision: true, functionCalling: true, streaming: true },
    ...over,
  }
}

/** A single fallback-chain entry. */
export function makeModelMappingEntry(over: Partial<ModelMappingEntry> = {}): ModelMappingEntry {
  return {
    providerId: "openai",
    modelId: "gpt-4.1",
    weight: 50,
    ...over,
  }
}

/** A complete alias → provider:model mapping with a 2-entry fallback chain. */
export function makeModelMapping(over: Partial<ModelMapping> = {}): ModelMapping {
  mappingSeq += 1
  const ts = Date.UTC(2026, 5, 20, 9, 0, 0) + mappingSeq * 60_000
  return {
    id: `mapping-${mappingSeq}`,
    alias: `alias-${mappingSeq}`,
    providers: [
      makeModelMappingEntry({ providerId: "anthropic", modelId: "claude-sonnet-4-6", weight: 70 }),
      makeModelMappingEntry({ providerId: "openai", modelId: "gpt-4.1", weight: 30 }),
    ],
    distribution: "priority",
    enabled: true,
    createdAt: ts,
    updatedAt: ts,
    ...over,
  }
}

/** A per-provider routing constraint. */
export function makeProviderConstraint(over: Partial<ProviderConstraint> = {}): ProviderConstraint {
  return {
    providerId: "openai",
    maxRequestsPerMinute: 60,
    maxTokensPerMinute: 200_000,
    dailyCostBudget: 25,
    priority: 1,
    enabled: true,
    ...over,
  }
}

/** A routing config based on the shipped defaults, overridable per field. */
export function makeRoutingConfig(over: Partial<RoutingConfig> = {}): RoutingConfig {
  return {
    ...DEFAULT_ROUTING_CONFIG,
    ...over,
  }
}

/** A single per-(provider:model) usage entry for the cost tab. */
export function makeProviderUsageEntry(
  over: Partial<ProviderModelUsageEntry> = {}
): ProviderModelUsageEntry {
  usageSeq += 1
  return {
    at: new Date(Date.UTC(2026, 5, 20, 9, 0, 0) + usageSeq * 3_600_000).toISOString(),
    modelId: "gpt-4.1",
    promptTokens: 1_200 + usageSeq * 100,
    completionTokens: 800 + usageSeq * 50,
    estimatedCost: 0.012 * usageSeq,
    ok: true,
    ...over,
  }
}

/**
 * A realistic `providerSettings` map keyed by provider id — three enabled
 * built-ins in varied health states, ready to seed into `useSettingsStore`.
 */
export function makeProviderSettingsMap(): Record<string, UserProviderSettings> {
  return {
    openai: makeUserProviderSettings({
      providerId: "openai",
      defaultModel: "gpt-4.1",
      enabledModels: ["gpt-4.1", "gpt-4.1-mini", "o3"],
    }),
    anthropic: makeUserProviderSettings({
      providerId: "anthropic",
      defaultModel: "claude-sonnet-4-6",
      enabledModels: ["claude-sonnet-4-6", "claude-opus-4-8"],
    }),
    deepseek: makeUserProviderSettings({
      providerId: "deepseek",
      defaultModel: "deepseek-v4-flash",
      enabled: false,
      verificationStatus: "unverified",
      healthStatus: "unknown",
      apiKey: undefined,
    }),
  }
}
