/**
 * Local Provider Clients - OpenAI-compatible local inference engines
 *
 * Shared descriptor + legacy helpers for local inference providers. The actual
 * control plane lives in `local-provider-service.ts`; these helpers remain for
 * older call sites/tests and must never bypass the injected `proxyFetch`.
 */

import type { ProviderName } from "@cognia/provider-types"
import { getBuiltInProviderCatalogEntry } from "@cognia/provider-types/built-in-provider-catalog"
import {
  LOCAL_PROVIDER_PORTS,
  LOCAL_PROVIDER_URLS,
  isLocalProviderName,
  type LocalProviderName,
} from "@cognia/provider-types/local-provider"
import { proxyFetch } from "./runtime-adapters"

/**
 * Local provider configuration
 */
export interface LocalProviderConfig {
  id: LocalProviderName
  name: string
  defaultPort: number
  defaultBaseURL: string
  modelsEndpoint: string
  healthEndpoint: string
  supportsModelList: boolean
  supportsEmbeddings: boolean
  description: string
  website: string
  icon?: string
}

type LocalProviderManagementDescriptor = Pick<
  LocalProviderConfig,
  "modelsEndpoint" | "healthEndpoint" | "supportsModelList" | "supportsEmbeddings" | "icon"
>

function createLocalProviderConfig(
  providerId: LocalProviderName,
  descriptor: LocalProviderManagementDescriptor
): LocalProviderConfig {
  const catalog = getBuiltInProviderCatalogEntry(providerId)
  if (!catalog) {
    throw new Error(`Missing built-in provider catalog entry: ${providerId}`)
  }

  return {
    id: providerId,
    name: catalog.name,
    defaultPort: LOCAL_PROVIDER_PORTS[providerId],
    defaultBaseURL: LOCAL_PROVIDER_URLS[providerId],
    description: catalog.description ?? "",
    website: catalog.website ?? catalog.docsUrl ?? "",
    ...descriptor,
  }
}

/**
 * Local provider server status
 */
export interface LocalProviderStatus {
  connected: boolean
  version?: string
  models_count?: number
  error?: string
}

/**
 * Local model info (generic for OpenAI-compatible APIs)
 */
export interface LocalModel {
  id: string
  object?: string
  created?: number
  owned_by?: string
}

/**
 * Configuration for all supported local providers.
 *
 * This is the active descriptor for base URLs plus health/model endpoints.
 * Keep transport helpers derived from here; do not duplicate the same facts in
 * per-call tables.
 */
export const LOCAL_PROVIDER_CONFIGS: Record<LocalProviderName, LocalProviderConfig> = {
  ollama: createLocalProviderConfig("ollama", {
    modelsEndpoint: "/api/tags",
    healthEndpoint: "/api/version",
    supportsModelList: true,
    supportsEmbeddings: true,
    icon: "/icons/providers/ollama.svg",
  }),
  lmstudio: createLocalProviderConfig("lmstudio", {
    modelsEndpoint: "/v1/models",
    healthEndpoint: "/v1/models",
    supportsModelList: true,
    supportsEmbeddings: true,
    icon: "/icons/providers/lmstudio.svg",
  }),
  llamacpp: createLocalProviderConfig("llamacpp", {
    modelsEndpoint: "/v1/models",
    healthEndpoint: "/health",
    supportsModelList: true,
    supportsEmbeddings: true,
  }),
  llamafile: createLocalProviderConfig("llamafile", {
    modelsEndpoint: "/v1/models",
    healthEndpoint: "/health",
    supportsModelList: true,
    supportsEmbeddings: false,
  }),
  vllm: createLocalProviderConfig("vllm", {
    modelsEndpoint: "/v1/models",
    healthEndpoint: "/health",
    supportsModelList: true,
    supportsEmbeddings: true,
    icon: "/icons/providers/vllm.svg",
  }),
  localai: createLocalProviderConfig("localai", {
    modelsEndpoint: "/v1/models",
    healthEndpoint: "/readyz",
    supportsModelList: true,
    supportsEmbeddings: true,
  }),
  jan: createLocalProviderConfig("jan", {
    modelsEndpoint: "/v1/models",
    healthEndpoint: "/v1/models",
    supportsModelList: true,
    supportsEmbeddings: true,
  }),
  textgenwebui: createLocalProviderConfig("textgenwebui", {
    modelsEndpoint: "/v1/models",
    healthEndpoint: "/v1/models",
    supportsModelList: true,
    supportsEmbeddings: false,
  }),
  koboldcpp: createLocalProviderConfig("koboldcpp", {
    modelsEndpoint: "/v1/models",
    healthEndpoint: "/api/v1/model",
    supportsModelList: true,
    supportsEmbeddings: false,
  }),
  tabbyapi: createLocalProviderConfig("tabbyapi", {
    modelsEndpoint: "/v1/models",
    healthEndpoint: "/health",
    supportsModelList: true,
    supportsEmbeddings: false,
  }),
}

function formatHttpError(status: number): string {
  if (status === 401 || status === 403) {
    return `Authentication failed (HTTP ${status})`
  }
  return `HTTP ${status}`
}

/**
 * Get default base URL for a local provider from canonical type definitions.
 * Falls back to LOCAL_PROVIDER_CONFIGS if provider is unknown.
 */
export function getDefaultLocalProviderUrl(providerId: ProviderName): string {
  if (isLocalProviderName(providerId)) {
    return LOCAL_PROVIDER_URLS[providerId]
  }
  return LOCAL_PROVIDER_CONFIGS[providerId as LocalProviderName]?.defaultBaseURL || ""
}

/**
 * Get default port for a local provider from canonical type definitions.
 */
export function getDefaultLocalProviderPort(providerId: ProviderName): number {
  if (isLocalProviderName(providerId)) {
    return LOCAL_PROVIDER_PORTS[providerId]
  }
  return LOCAL_PROVIDER_CONFIGS[providerId as LocalProviderName]?.defaultPort || 0
}

/**
 * Normalize base URL - remove trailing slashes and a compatibility `/v1` suffix.
 */
export function normalizeBaseUrl(baseUrl: string): string {
  let url = baseUrl.trim().replace(/\/+$/, "")
  if (url.endsWith("/v1")) {
    url = url.slice(0, -3)
  }
  return url
}

/**
 * Get local provider status using the shared descriptor + proxy transport.
 */
export async function getLocalProviderStatus(
  providerId: string,
  baseUrl?: string
): Promise<LocalProviderStatus> {
  const config = LOCAL_PROVIDER_CONFIGS[providerId as LocalProviderName]
  if (!config) {
    return { connected: false, error: `Unknown provider: ${providerId}` }
  }

  const url = normalizeBaseUrl(baseUrl || config.defaultBaseURL)

  try {
    const response = await proxyFetch(`${url}${config.healthEndpoint}`, {
      method: "GET",
      timeout: 5000,
    })

    if (!response.ok) {
      return { connected: false, error: formatHttpError(response.status) }
    }

    const data = await response.json().catch(() => ({}))
    return {
      connected: true,
      version: data.version || data.build?.version,
      models_count: Array.isArray(data.models)
        ? data.models.length
        : Array.isArray(data.data)
          ? data.data.length
          : undefined,
    }
  } catch (error) {
    return {
      connected: false,
      error: error instanceof Error ? error.message : "Connection failed",
    }
  }
}

/**
 * List models from a local provider using the descriptor's canonical endpoint.
 */
export async function listLocalProviderModels(
  providerId: string,
  baseUrl?: string
): Promise<LocalModel[]> {
  const config = LOCAL_PROVIDER_CONFIGS[providerId as LocalProviderName]
  if (!config || !config.supportsModelList) {
    return []
  }

  const url = normalizeBaseUrl(baseUrl || config.defaultBaseURL)

  try {
    const response = await proxyFetch(`${url}${config.modelsEndpoint}`, {
      method: "GET",
      timeout: 10000,
    })

    if (!response.ok) {
      throw new Error(formatHttpError(response.status))
    }

    const data = await response.json()

    if (Array.isArray(data.models)) {
      return data.models.map((m: { name?: string; model?: string; owned_by?: string }) => ({
        id: m.name || m.model || "",
        object: "model",
        owned_by: m.owned_by,
      }))
    }

    if (Array.isArray(data.data)) {
      return data.data.map((m: LocalModel) => ({
        id: m.id,
        object: m.object || "model",
        created: m.created,
        owned_by: m.owned_by,
      }))
    }

    throw new Error("Invalid model list response")
  } catch (error) {
    if (error instanceof Error) throw error
    throw new Error("Failed to list models")
  }
}

/**
 * Test connection to a local provider.
 */
export async function testLocalProviderConnection(
  providerId: string,
  baseUrl?: string
): Promise<{ success: boolean; message: string; latency?: number }> {
  const startTime = Date.now()

  try {
    const status = await getLocalProviderStatus(providerId, baseUrl)
    const latency = Date.now() - startTime

    if (status.connected) {
      const modelCount = status.models_count ? ` (${status.models_count} models)` : ""
      const version = status.version ? ` v${status.version}` : ""
      return {
        success: true,
        message: `Connected${version}${modelCount}`,
        latency,
      }
    }

    return {
      success: false,
      message: status.error || "Connection failed",
      latency,
    }
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : "Connection failed",
      latency: Date.now() - startTime,
    }
  }
}

/**
 * Get the default base URL for a local provider.
 */
export function getDefaultBaseURL(providerId: string): string {
  const config = LOCAL_PROVIDER_CONFIGS[providerId as LocalProviderName]
  return config?.defaultBaseURL || "http://localhost:8080"
}

/**
 * Check if a provider is a local provider.
 */
export function isLocalProvider(providerId: string): boolean {
  return providerId in LOCAL_PROVIDER_CONFIGS
}

/**
 * Get all local provider IDs.
 */
export function getLocalProviderIds(): string[] {
  return Object.keys(LOCAL_PROVIDER_CONFIGS)
}
