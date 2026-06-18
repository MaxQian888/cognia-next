import type { ApiProtocol, UserProviderSettings } from "@/types/provider"
import {
  getBuiltInProviderCatalogEntry,
  getBuiltInProviderSettingsBaseURL,
  type BuiltInProviderAdapterId,
  type BuiltInProviderFamily,
  type BuiltInProviderProtocol,
} from "@/types/provider/built-in-provider-catalog"
import {
  resolveEquivalentBuiltInProviderId,
  type EquivalentCustomProviderLike,
} from "./built-in-provider-compatibility"
import { resolveBuiltInProviderAdapter, resolveCustomProviderAdapter } from "./provider-adapters"

export interface NormalizedProviderConfig {
  providerId: string
  source: "built-in" | "custom"
  adapterId: BuiltInProviderAdapterId
  family: BuiltInProviderFamily
  protocol: ApiProtocol | BuiltInProviderProtocol
  apiKey: string
  baseURL?: string
  defaultModel?: string
  enabled: boolean
  requiresCredential: boolean
  requiresBaseUrl: boolean
  isLocal: boolean
  equivalentBuiltInProviderId?: string
}

function normalizeOptionalBaseURL(baseURL?: string): string | undefined {
  const trimmed = baseURL?.trim()
  return trimmed ? trimmed : undefined
}

function getActiveCredential(
  settings?: Partial<Pick<UserProviderSettings, "apiKey" | "apiKeys" | "currentKeyIndex">>
): string {
  if (settings?.apiKeys?.length) {
    const index = settings.currentKeyIndex ?? 0
    return settings.apiKeys[index] || settings.apiKey?.trim() || ""
  }

  return settings?.apiKey?.trim() || ""
}

export function normalizeBuiltInProviderConfig(
  providerId: string,
  settings?: Partial<UserProviderSettings>
): NormalizedProviderConfig {
  const entry = getBuiltInProviderCatalogEntry(providerId)
  const adapter =
    resolveBuiltInProviderAdapter(providerId) ||
    resolveCustomProviderAdapter(providerId, { apiProtocol: entry?.protocol || "openai" })

  return {
    providerId,
    source: "built-in",
    adapterId: adapter.id,
    family: adapter.family,
    protocol: adapter.protocol,
    apiKey: getActiveCredential(settings),
    baseURL:
      normalizeOptionalBaseURL(settings?.baseURL) || getBuiltInProviderSettingsBaseURL(providerId),
    defaultModel: settings?.defaultModel || entry?.defaultModel,
    enabled: settings?.enabled ?? false,
    requiresCredential: adapter.builtInDefaults.requiresCredential,
    requiresBaseUrl: adapter.builtInDefaults.requiresBaseUrl,
    isLocal: adapter.builtInDefaults.isLocal,
  }
}

export function normalizeCustomProviderConfig(
  providerId: string,
  provider?: EquivalentCustomProviderLike
): NormalizedProviderConfig {
  const equivalentBuiltInProviderId = provider
    ? resolveEquivalentBuiltInProviderId(provider)
    : undefined
  const adapter = resolveCustomProviderAdapter(providerId, provider)

  return {
    providerId,
    source: "custom",
    adapterId: adapter.id,
    family: adapter.family,
    protocol: adapter.protocol,
    apiKey: provider?.apiKey?.trim() || "",
    baseURL: normalizeOptionalBaseURL(provider?.baseURL),
    defaultModel: provider?.defaultModel,
    enabled: provider?.enabled ?? false,
    requiresCredential: adapter.customDefaults.requiresCredential,
    requiresBaseUrl: adapter.customDefaults.requiresBaseUrl,
    isLocal: adapter.customDefaults.isLocal,
    equivalentBuiltInProviderId,
  }
}
