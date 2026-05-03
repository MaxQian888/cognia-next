import {
  getBuiltInProviderCatalog,
  getBuiltInProviderCatalogEntry,
  getBuiltInProviderSettingsBaseURL,
  type BuiltInProviderId,
} from "@/types/provider/built-in-provider-catalog"
import type { ProviderModelDiscoveryEntry } from "@/types/provider"
import { getProviderConfig } from "@/types/provider"
import { buildCustomProviderModelDiscoverySnapshot } from "./model-discovery"

export interface EquivalentCustomProviderLike {
  providerId?: string
  customName?: string
  baseURL?: string
  apiKey?: string
  apiProtocol?: "openai" | "anthropic" | "gemini"
  customModels?: string[]
  customModelMetadata?: Record<
    string,
    {
      id?: string
      name?: string
      contextLength?: number
      maxOutputTokens?: number
      pricing?: {
        promptPer1M?: number
        completionPer1M?: number
      }
      capabilities?: {
        vision?: boolean
        functionCalling?: boolean
        streaming?: boolean
      }
    }
  >
  models?: string[]
  discoveredModels?: ProviderModelDiscoveryEntry[]
  discoveredModelsLastFetched?: number
  defaultModel?: string
  enabled?: boolean
}

export interface EquivalentBuiltInProviderCandidate {
  builtInProviderId: BuiltInProviderId
  customProviderId: string
  provider: EquivalentCustomProviderLike
}

function normalizeBaseURL(baseURL?: string): string | null {
  if (!baseURL) return null

  try {
    const url = new URL(baseURL)
    const normalizedPath = url.pathname.replace(/\/+$/, "")
    return `${url.origin}${normalizedPath}`
  } catch {
    return null
  }
}

function getEquivalentProviderHints(provider: EquivalentCustomProviderLike): string[] {
  const snapshot = buildCustomProviderModelDiscoverySnapshot({
    providerId: provider.providerId || "equivalent-custom-provider",
    provider,
  })

  return [
    provider.customName,
    provider.defaultModel,
    ...(provider.customModels || []),
    ...(provider.models || []),
    ...snapshot.models.flatMap((model) => [model.id, model.name]),
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase())
}

export function resolveEquivalentBuiltInProviderId(
  provider: EquivalentCustomProviderLike
): BuiltInProviderId | undefined {
  const haystacks = getEquivalentProviderHints(provider)

  const normalizedBaseURL = normalizeBaseURL(provider.baseURL)
  if (!normalizedBaseURL) return undefined

  return getBuiltInProviderCatalog()
    .filter((entry) => Boolean(entry.compatibility))
    .find((entry) => {
      const rule = entry.compatibility
      if (!rule) return false
      if ((provider.apiProtocol || "openai") !== rule.protocol) return false

      const matchesBaseURL = rule.baseURLs
        .map((url) => normalizeBaseURL(url))
        .filter((url): url is string => Boolean(url))
        .includes(normalizedBaseURL)

      if (!matchesBaseURL) return false

      const matchesName = (rule.nameIncludes || []).some((fragment) =>
        haystacks.some((value) => value.includes(fragment.toLowerCase()))
      )
      const matchesModelPrefix = (rule.modelPrefixes || []).some((prefix) =>
        haystacks.some((value) => value.startsWith(prefix.toLowerCase()))
      )

      return matchesName || matchesModelPrefix
    })?.id as BuiltInProviderId | undefined
}

export function findEquivalentBuiltInProviderCandidates(
  customProviders: Record<string, EquivalentCustomProviderLike | undefined>
): Partial<Record<BuiltInProviderId, EquivalentBuiltInProviderCandidate>> {
  const candidates: Partial<Record<BuiltInProviderId, EquivalentBuiltInProviderCandidate>> = {}

  for (const [customProviderId, provider] of Object.entries(customProviders)) {
    if (!provider) continue
    const builtInProviderId = resolveEquivalentBuiltInProviderId(provider)
    if (!builtInProviderId || candidates[builtInProviderId]) continue

    candidates[builtInProviderId] = {
      builtInProviderId,
      customProviderId,
      provider,
    }
  }

  return candidates
}

export function buildBuiltInSettingsFromCustomProvider(
  providerId: BuiltInProviderId,
  provider: EquivalentCustomProviderLike
) {
  const entry = getBuiltInProviderCatalogEntry(providerId)
  const providerConfig = getProviderConfig(providerId)
  const modelSnapshot = buildCustomProviderModelDiscoverySnapshot({
    providerId: provider.providerId || providerId,
    provider,
  })
  const allowedModelIds = new Set(
    providerConfig?.models.map((model) => model.id) || entry?.models?.map((model) => model.id) || []
  )
  const firstAllowedDiscoveredModel = modelSnapshot.models.find((model) =>
    allowedModelIds.has(model.id)
  )?.id

  const nextDefaultModel =
    provider.defaultModel && allowedModelIds.has(provider.defaultModel)
      ? provider.defaultModel
      : firstAllowedDiscoveredModel || entry?.defaultModel || provider.defaultModel || "gpt-4o"

  return {
    providerId,
    apiKey: provider.apiKey?.trim() || "",
    defaultModel: nextDefaultModel,
    enabled: provider.enabled ?? false,
    discoveredModels: provider.discoveredModels?.map((model) => ({ ...model })),
    discoveredModelsLastFetched: provider.discoveredModelsLastFetched,
    baseURL: entry?.baseURLRequired ? getBuiltInProviderSettingsBaseURL(providerId) : undefined,
    verificationStatus: "unverified" as const,
    verificationMessage: undefined,
  }
}
