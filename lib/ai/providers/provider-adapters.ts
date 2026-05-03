import type { ApiProtocol } from "@/types/provider"
import {
  getBuiltInProviderAdapter,
  getBuiltInProviderCatalogEntry,
  getBuiltInProviderFamily,
  getBuiltInProviderProtocol,
  type BuiltInProviderAdapterId,
  type BuiltInProviderFamily,
  type BuiltInProviderProtocol,
} from "@/types/provider/built-in-provider-catalog"
import {
  resolveEquivalentBuiltInProviderId,
  type EquivalentCustomProviderLike,
} from "./built-in-provider-compatibility"

export interface ProviderAdapterRequirements {
  requiresCredential: boolean
  requiresBaseUrl: boolean
  isLocal: boolean
}

export interface ProviderAdapterDefinition {
  id: BuiltInProviderAdapterId
  family: BuiltInProviderFamily
  protocol: ApiProtocol | BuiltInProviderProtocol
  builtInDefaults: ProviderAdapterRequirements
  customDefaults: ProviderAdapterRequirements
}

const PROVIDER_ADAPTERS: Record<BuiltInProviderAdapterId, ProviderAdapterDefinition> = {
  "openai-compatible": {
    id: "openai-compatible",
    family: "openai-compatible",
    protocol: "openai",
    builtInDefaults: {
      requiresCredential: true,
      requiresBaseUrl: false,
      isLocal: false,
    },
    customDefaults: {
      requiresCredential: true,
      requiresBaseUrl: true,
      isLocal: false,
    },
  },
  anthropic: {
    id: "anthropic",
    family: "anthropic-native",
    protocol: "anthropic",
    builtInDefaults: {
      requiresCredential: true,
      requiresBaseUrl: false,
      isLocal: false,
    },
    customDefaults: {
      requiresCredential: true,
      requiresBaseUrl: true,
      isLocal: false,
    },
  },
  gemini: {
    id: "gemini",
    family: "gemini-native",
    protocol: "gemini",
    builtInDefaults: {
      requiresCredential: true,
      requiresBaseUrl: false,
      isLocal: false,
    },
    customDefaults: {
      requiresCredential: true,
      requiresBaseUrl: true,
      isLocal: false,
    },
  },
  openrouter: {
    id: "openrouter",
    family: "openrouter",
    protocol: "openai",
    builtInDefaults: {
      requiresCredential: true,
      requiresBaseUrl: false,
      isLocal: false,
    },
    customDefaults: {
      requiresCredential: true,
      requiresBaseUrl: true,
      isLocal: false,
    },
  },
  "local-openai-compatible": {
    id: "local-openai-compatible",
    family: "local-openai-compatible",
    protocol: "openai",
    builtInDefaults: {
      requiresCredential: false,
      requiresBaseUrl: true,
      isLocal: true,
    },
    customDefaults: {
      requiresCredential: false,
      requiresBaseUrl: true,
      isLocal: true,
    },
  },
  cliproxyapi: {
    id: "cliproxyapi",
    family: "proxy-openai-compatible",
    protocol: "openai",
    builtInDefaults: {
      requiresCredential: true,
      requiresBaseUrl: true,
      isLocal: true,
    },
    customDefaults: {
      requiresCredential: true,
      requiresBaseUrl: true,
      isLocal: false,
    },
  },
}

const PROTOCOL_ADAPTER_IDS: Record<ApiProtocol, BuiltInProviderAdapterId> = {
  openai: "openai-compatible",
  anthropic: "anthropic",
  gemini: "gemini",
}

function inferBuiltInAdapterId(providerId: string): BuiltInProviderAdapterId {
  const entry = getBuiltInProviderCatalogEntry(providerId)
  const adapterId = getBuiltInProviderAdapter(providerId)

  if (adapterId) {
    return adapterId
  }

  if (providerId === "cliproxyapi") {
    return "cliproxyapi"
  }

  if (entry?.type === "local") {
    return "local-openai-compatible"
  }

  const protocol = getBuiltInProviderProtocol(providerId)
  if (protocol === "anthropic") return "anthropic"
  if (protocol === "gemini") return "gemini"
  if (getBuiltInProviderFamily(providerId) === "openrouter") return "openrouter"
  return "openai-compatible"
}

export function getProviderAdapter(
  adapterId: BuiltInProviderAdapterId | undefined
): ProviderAdapterDefinition | undefined {
  if (!adapterId) return undefined
  return PROVIDER_ADAPTERS[adapterId]
}

export function resolveBuiltInProviderAdapter(
  providerId: string
): ProviderAdapterDefinition | undefined {
  return getProviderAdapter(inferBuiltInAdapterId(providerId))
}

export function resolveCustomProviderAdapter(
  providerId: string,
  provider?: EquivalentCustomProviderLike
): ProviderAdapterDefinition {
  const equivalentBuiltInProviderId = provider
    ? resolveEquivalentBuiltInProviderId(provider)
    : undefined

  if (equivalentBuiltInProviderId) {
    return (
      resolveBuiltInProviderAdapter(equivalentBuiltInProviderId) ||
      PROVIDER_ADAPTERS["openai-compatible"]
    )
  }

  const protocol = provider?.apiProtocol || "openai"
  return PROVIDER_ADAPTERS[PROTOCOL_ADAPTER_IDS[protocol]]
}
