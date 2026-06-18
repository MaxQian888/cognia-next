/**
 * Local Provider Clients - OpenAI-compatible local inference engines
 *
 * All local providers use the OpenAI-compatible API, so they share common
 * patterns for connection testing, model listing, and server status checks.
 */

import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "@/lib/platform/detect"
import type { ProviderName } from "@/types/provider"
import {
  LOCAL_PROVIDER_PORTS,
  LOCAL_PROVIDER_URLS,
  isLocalProviderName,
  type LocalProviderName,
} from "@/types/provider/local-provider"

/**
 * Local provider configuration
 */
export interface LocalProviderConfig {
  id: ProviderName
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
 * Configuration for all supported local providers
 */
export const LOCAL_PROVIDER_CONFIGS: Record<string, LocalProviderConfig> = {
  ollama: {
    id: "ollama",
    name: "Ollama",
    defaultPort: 11434,
    defaultBaseURL: "http://localhost:11434",
    modelsEndpoint: "/api/tags",
    healthEndpoint: "/api/version",
    supportsModelList: true,
    supportsEmbeddings: true,
    description: "Run models locally with easy model management",
    website: "https://ollama.ai",
    icon: "/icons/providers/ollama.svg",
  },
  lmstudio: {
    id: "lmstudio",
    name: "LM Studio",
    defaultPort: 1234,
    defaultBaseURL: "http://localhost:1234",
    modelsEndpoint: "/v1/models",
    healthEndpoint: "/v1/models",
    supportsModelList: true,
    supportsEmbeddings: true,
    description: "Desktop app for running local LLMs with OpenAI-compatible API",
    website: "https://lmstudio.ai",
    icon: "/icons/providers/lmstudio.svg",
  },
  llamacpp: {
    id: "llamacpp",
    name: "llama.cpp Server",
    defaultPort: 8080,
    defaultBaseURL: "http://localhost:8080",
    modelsEndpoint: "/v1/models",
    healthEndpoint: "/health",
    supportsModelList: true,
    supportsEmbeddings: true,
    description: "High-performance C++ inference server for GGUF models",
    website: "https://github.com/ggerganov/llama.cpp",
  },
  llamafile: {
    id: "llamafile",
    name: "llamafile",
    defaultPort: 8080,
    defaultBaseURL: "http://localhost:8080",
    modelsEndpoint: "/v1/models",
    healthEndpoint: "/health",
    supportsModelList: true,
    supportsEmbeddings: false,
    description: "Single-file executable LLM with built-in server",
    website: "https://github.com/Mozilla-Ocho/llamafile",
  },
  vllm: {
    id: "vllm",
    name: "vLLM",
    defaultPort: 8000,
    defaultBaseURL: "http://localhost:8000",
    modelsEndpoint: "/v1/models",
    healthEndpoint: "/health",
    supportsModelList: true,
    supportsEmbeddings: true,
    description: "High-throughput GPU inference engine with PagedAttention",
    website: "https://vllm.ai",
    icon: "/icons/providers/vllm.svg",
  },
  localai: {
    id: "localai",
    name: "LocalAI",
    defaultPort: 8080,
    defaultBaseURL: "http://localhost:8080",
    modelsEndpoint: "/v1/models",
    healthEndpoint: "/readyz",
    supportsModelList: true,
    supportsEmbeddings: true,
    description: "Self-hosted OpenAI alternative with multiple backends",
    website: "https://localai.io",
  },
  jan: {
    id: "jan",
    name: "Jan",
    defaultPort: 1337,
    defaultBaseURL: "http://localhost:1337",
    modelsEndpoint: "/v1/models",
    healthEndpoint: "/v1/models",
    supportsModelList: true,
    supportsEmbeddings: true,
    description: "Open-source ChatGPT alternative with local-first design",
    website: "https://jan.ai",
  },
  textgenwebui: {
    id: "textgenwebui",
    name: "Text Generation WebUI",
    defaultPort: 5000,
    defaultBaseURL: "http://localhost:5000",
    modelsEndpoint: "/v1/models",
    healthEndpoint: "/v1/models",
    supportsModelList: true,
    supportsEmbeddings: false,
    description: "Gradio web UI with OpenAI-compatible API extension",
    website: "https://github.com/oobabooga/text-generation-webui",
  },
  koboldcpp: {
    id: "koboldcpp",
    name: "KoboldCpp",
    defaultPort: 5001,
    defaultBaseURL: "http://localhost:5001",
    modelsEndpoint: "/v1/models",
    healthEndpoint: "/api/v1/model",
    supportsModelList: true,
    supportsEmbeddings: false,
    description: "Easy-to-use llama.cpp fork with web UI and API",
    website: "https://github.com/LostRuins/koboldcpp",
  },
  tabbyapi: {
    id: "tabbyapi",
    name: "TabbyAPI",
    defaultPort: 5000,
    defaultBaseURL: "http://localhost:5000",
    modelsEndpoint: "/v1/models",
    healthEndpoint: "/health",
    supportsModelList: true,
    supportsEmbeddings: false,
    description: "Exllamav2 API server with OpenAI-compatible endpoints",
    website: "https://github.com/theroyallab/tabbyAPI",
  },
}

/**
 * Get default base URL for a local provider from canonical type definitions.
 * Falls back to LOCAL_PROVIDER_CONFIGS if provider is unknown.
 */
export function getDefaultLocalProviderUrl(providerId: ProviderName): string {
  if (isLocalProviderName(providerId)) {
    return LOCAL_PROVIDER_URLS[providerId as LocalProviderName]
  }
  return LOCAL_PROVIDER_CONFIGS[providerId]?.defaultBaseURL || ""
}

/**
 * Get default port for a local provider from canonical type definitions.
 */
export function getDefaultLocalProviderPort(providerId: ProviderName): number {
  if (isLocalProviderName(providerId)) {
    return LOCAL_PROVIDER_PORTS[providerId as LocalProviderName]
  }
  return LOCAL_PROVIDER_CONFIGS[providerId]?.defaultPort || 0
}

/**
 * Normalize base URL - remove trailing slashes
 */
export function normalizeBaseUrl(baseUrl: string): string {
  let url = baseUrl.trim().replace(/\/+$/, "")
  // Remove /v1 suffix if present for health checks
  if (url.endsWith("/v1")) {
    url = url.slice(0, -3)
  }
  return url
}

/**
 * Get local provider status (generic for OpenAI-compatible APIs)
 */
export async function getLocalProviderStatus(
  providerId: string,
  baseUrl?: string
): Promise<LocalProviderStatus> {
  const config = LOCAL_PROVIDER_CONFIGS[providerId]
  if (!config) {
    return { connected: false, error: `Unknown provider: ${providerId}` }
  }

  const url = normalizeBaseUrl(baseUrl || config.defaultBaseURL)

  // For Ollama, use dedicated Tauri command if available
  if (providerId === "ollama" && isTauri()) {
    try {
      return await invoke<LocalProviderStatus>("ollama_get_status", { baseUrl: url })
    } catch {
      // Fall through to HTTP check
    }
  }

  // Generic HTTP health check
  try {
    const healthUrl = `${url}${config.healthEndpoint}`
    const response = await fetch(healthUrl, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    })

    if (response.ok) {
      const data = await response.json().catch(() => ({}))
      return {
        connected: true,
        version: data.version || data.build?.version,
        models_count: data.models?.length,
      }
    }

    return { connected: false, error: `HTTP ${response.status}` }
  } catch (error) {
    return {
      connected: false,
      error: error instanceof Error ? error.message : "Connection failed",
    }
  }
}

/**
 * List models from a local provider (OpenAI-compatible /v1/models endpoint)
 */
export async function listLocalProviderModels(
  providerId: string,
  baseUrl?: string
): Promise<LocalModel[]> {
  const config = LOCAL_PROVIDER_CONFIGS[providerId]
  if (!config || !config.supportsModelList) {
    return []
  }

  const url = normalizeBaseUrl(baseUrl || config.defaultBaseURL)

  // For Ollama, use dedicated Tauri command if available
  if (providerId === "ollama" && isTauri()) {
    try {
      const models = await invoke<Array<{ name: string; model: string }>>("ollama_list_models", {
        baseUrl: url,
      })
      return models.map((m) => ({ id: m.name || m.model, object: "model" }))
    } catch {
      // Fall through to HTTP check
    }
  }

  try {
    const modelsUrl = providerId === "ollama" ? `${url}/api/tags` : `${url}/v1/models`

    const response = await fetch(modelsUrl, {
      method: "GET",
      signal: AbortSignal.timeout(10000),
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }

    const data = await response.json()

    // Handle Ollama format
    if (data.models) {
      return data.models.map((m: { name?: string; model?: string }) => ({
        id: m.name || m.model,
        object: "model",
      }))
    }

    // Handle OpenAI format
    if (data.data) {
      return data.data
    }

    return []
  } catch {
    return []
  }
}

/**
 * Test connection to a local provider
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
 * Get the default base URL for a local provider
 */
export function getDefaultBaseURL(providerId: string): string {
  const config = LOCAL_PROVIDER_CONFIGS[providerId]
  return config?.defaultBaseURL || "http://localhost:8080"
}

/**
 * Check if a provider is a local provider
 */
export function isLocalProvider(providerId: string): boolean {
  return providerId in LOCAL_PROVIDER_CONFIGS
}

/**
 * Get all local provider IDs
 */
export function getLocalProviderIds(): string[] {
  return Object.keys(LOCAL_PROVIDER_CONFIGS)
}
