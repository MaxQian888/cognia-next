/**
 * Local Model Provider type definitions
 * Types for local inference frameworks like LM Studio, llama.cpp, vLLM, etc.
 */

import type { ProviderName } from "./provider"

/**
 * Local provider IDs - all frameworks that run models locally
 */
export type LocalProviderName =
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
export function isLocalProviderName(name: ProviderName): name is LocalProviderName {
  const localProviders: LocalProviderName[] = [
    "ollama",
    "lmstudio",
    "llamacpp",
    "llamafile",
    "vllm",
    "localai",
    "jan",
    "textgenwebui",
    "koboldcpp",
    "tabbyapi",
  ]
  return localProviders.includes(name as LocalProviderName)
}

/**
 * Local provider server configuration
 */
export interface LocalProviderServer {
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
export interface LocalProviderFeatures {
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
export interface LocalServerStatus {
  connected: boolean
  version?: string
  models_count?: number
  error?: string
  latency_ms?: number
}

/**
 * Model info from OpenAI-compatible /v1/models endpoint
 */
export interface LocalModelInfo {
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
export interface LocalModelPullProgress {
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
export const LOCAL_PROVIDER_PORTS: Record<LocalProviderName, number> = {
  ollama: 11434,
  lmstudio: 1234,
  llamacpp: 8080,
  llamafile: 8080,
  vllm: 8000,
  localai: 8080,
  jan: 1337,
  textgenwebui: 5000,
  koboldcpp: 5001,
  tabbyapi: 5000,
}

/**
 * Default base URLs for local providers (without /v1 suffix)
 */
export const LOCAL_PROVIDER_URLS: Record<LocalProviderName, string> = {
  ollama: "http://localhost:11434",
  lmstudio: "http://localhost:1234",
  llamacpp: "http://localhost:8080",
  llamafile: "http://localhost:8080",
  vllm: "http://localhost:8000",
  localai: "http://localhost:8080",
  jan: "http://localhost:1337",
  textgenwebui: "http://localhost:5000",
  koboldcpp: "http://localhost:5001",
  tabbyapi: "http://localhost:5000",
}

/**
 * Format model size in bytes to human-readable string
 * Named differently from ollama.ts to avoid export conflict
 */
export function formatLocalModelSize(bytes: number): string {
  if (bytes === 0) return "0 B"
  const k = 1024
  const sizes = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}

/**
 * Get the OpenAI-compatible base URL for a local provider
 * Adds /v1 suffix if needed
 */
export function getOpenAICompatibleURL(baseURL: string): string {
  const url = baseURL.trim().replace(/\/+$/, "")
  if (url.endsWith("/v1")) {
    return url
  }
  return `${url}/v1`
}
