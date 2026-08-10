import { ProviderName } from "./provider.js"
import "./built-in-provider-catalog.js"
import "./bedrock.js"

/**
 * Local Model Provider type definitions
 * Types for local inference frameworks like LM Studio, llama.cpp, vLLM, etc.
 */

/**
 * Local provider IDs - all frameworks that run models locally
 */
type LocalProviderName =
  | "ollama"
  | "lmstudio"
  | "llamacpp"
  | "llamafile"
  | "vllm"
  | "localai"
  | "jan"
  | "textgenwebui"
  | "koboldcpp"
  | "tabbyapi"
/**
 * Check if a provider is a local provider
 */
declare function isLocalProviderName(name: ProviderName): name is LocalProviderName
/**
 * Local provider server configuration
 */
interface LocalProviderServer {
  id: LocalProviderName
  name: string
  baseURL: string
  defaultPort: number
  description: string
  website: string
  docsUrl?: string
  features: LocalProviderFeatures
}
/**
 * Features supported by a local provider
 */
interface LocalProviderFeatures {
  /** Supports /v1/models endpoint */
  supportsModelList: boolean
  /** Supports /v1/embeddings endpoint */
  supportsEmbeddings: boolean
  /** Supports vision/multimodal models */
  supportsVision: boolean
  /** Supports tool calling */
  supportsTools: boolean
  /** Supports streaming responses */
  supportsStreaming: boolean
  /** Can manage/pull/delete models */
  supportsModelManagement: boolean
}
/**
 * Server status response
 */
interface LocalServerStatus {
  connected: boolean
  version?: string
  models_count?: number
  error?: string
  latency_ms?: number
}
/**
 * Model info from OpenAI-compatible /v1/models endpoint
 */
interface LocalModelInfo {
  id: string
  object?: string
  created?: number
  owned_by?: string
  /** Model size in bytes (if available) */
  size?: number
  /** Model family/architecture */
  family?: string
  /** Quantization level (e.g., Q4_K_M) */
  quantization?: string
  /** Context length */
  context_length?: number
}
/**
 * Model download/pull progress
 */
interface LocalModelPullProgress {
  model: string
  status: string
  digest?: string
  total?: number
  completed?: number
  percentage?: number
}
/**
 * Default ports for local providers
 */
declare const LOCAL_PROVIDER_PORTS: Record<LocalProviderName, number>
/**
 * Default base URLs for local providers (without /v1 suffix)
 */
declare const LOCAL_PROVIDER_URLS: Record<LocalProviderName, string>
/**
 * Format model size in bytes to human-readable string
 * Named differently from ollama.ts to avoid export conflict
 */
declare function formatLocalModelSize(bytes: number): string
/**
 * Get the OpenAI-compatible base URL for a local provider
 * Adds /v1 suffix if needed
 */
declare function getOpenAICompatibleURL(baseURL: string): string

export {
  LOCAL_PROVIDER_PORTS,
  LOCAL_PROVIDER_URLS,
  type LocalModelInfo,
  type LocalModelPullProgress,
  type LocalProviderFeatures,
  type LocalProviderName,
  type LocalProviderServer,
  type LocalServerStatus,
  formatLocalModelSize,
  getOpenAICompatibleURL,
  isLocalProviderName,
}
