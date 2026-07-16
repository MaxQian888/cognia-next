/**
 * Ollama API type definitions
 * Types for local model management via Ollama
 */

/**
 * Ollama model details
 */
export interface OllamaModelDetails {
  parent_model?: string
  format?: string
  family?: string
  families?: string[]
  parameter_size?: string
  quantization_level?: string
}

/**
 * Ollama model information
 */
export interface OllamaModel {
  name: string
  model: string
  modified_at: string
  size: number
  digest: string
  details?: OllamaModelDetails
}

/**
 * Ollama server status
 */
export interface OllamaServerStatus {
  connected: boolean
  version?: string
  models_count: number
}

/**
 * Ollama model pull progress event
 */
export interface OllamaPullProgress {
  status: string
  digest?: string
  total?: number
  completed?: number
  model: string
}

/**
 * Ollama running model info
 */
export interface OllamaRunningModel {
  name: string
  model: string
  size: number
  digest: string
  expires_at?: string
  size_vram?: number
}

/**
 * The complete set of capability strings `/api/show` can report.
 *
 * Verified against the upstream enum in `ollama/types/model/capability.go`,
 * which is the only place the closed set exists — the published OpenAPI schema
 * types `capabilities` as a bare `array of string` and enumerates nothing.
 */
export const OLLAMA_CAPABILITIES = [
  "completion",
  "tools",
  "insert",
  "vision",
  "embedding",
  "thinking",
  "image",
  "audio",
] as const

export type OllamaCapability = (typeof OLLAMA_CAPABILITIES)[number]

/**
 * Ollama model detailed info (from show endpoint)
 */
export interface OllamaModelInfo {
  modelfile?: string
  parameters?: string
  template?: string
  details?: OllamaModelDetails
  /**
   * Raw GGUF metadata. Keys are NOT fixed: everything outside the `general.`
   * and `tokenizer.` namespaces is prefixed with the model's architecture, so
   * context length arrives as `llama.context_length`, `qwen2.context_length`,
   * `gemma4.context_length`, … Read `general.architecture` first and build the
   * key — see `getOllamaModelCapabilities`.
   */
  model_info?: Record<string, unknown>
  /** Present on modern Ollama; absent on older servers. */
  capabilities?: OllamaCapability[]
}

/**
 * What a model can actually do, probed rather than guessed.
 */
export interface OllamaModelCapabilities {
  supportsVision: boolean
  supportsTools: boolean
  supportsEmbedding: boolean
  supportsThinking: boolean
  /** Real context window from GGUF metadata; undefined when unreported. */
  contextLength?: number
  /** e.g. "llama", "qwen2", "gemma4" — the prefix `model_info` keys carry. */
  architecture?: string
  /**
   * True when this came from a name-matching guess because the server did not
   * report capabilities (pre-capabilities Ollama, or an unreachable server).
   * Callers that display capabilities should mark these as uncertain rather
   * than presenting a guess with the same confidence as a probe.
   */
  inferred: boolean
}

/**
 * Ollama embedding model names
 */
export const OLLAMA_EMBEDDING_MODELS = [
  "nomic-embed-text",
  "mxbai-embed-large",
  "snowflake-arctic-embed",
  "all-minilm",
  "bge-m3",
  "bge-large",
] as const

export type OllamaEmbeddingModel = (typeof OLLAMA_EMBEDDING_MODELS)[number]

/**
 * Popular Ollama models for quick pull
 */
export const POPULAR_OLLAMA_MODELS = [
  { name: "llama3.2", description: "Meta Llama 3.2 (3B)", size: "2.0GB" },
  { name: "llama3.2:1b", description: "Meta Llama 3.2 (1B)", size: "1.3GB" },
  { name: "llama3.3", description: "Meta Llama 3.3 (70B)", size: "43GB" },
  { name: "qwen2.5", description: "Qwen 2.5 (7B)", size: "4.7GB" },
  { name: "qwen2.5:3b", description: "Qwen 2.5 (3B)", size: "1.9GB" },
  { name: "qwen2.5-coder", description: "Qwen 2.5 Coder (7B)", size: "4.7GB" },
  { name: "mistral", description: "Mistral (7B)", size: "4.1GB" },
  { name: "mixtral", description: "Mixtral 8x7B", size: "26GB" },
  { name: "gemma2", description: "Google Gemma 2 (9B)", size: "5.4GB" },
  { name: "gemma2:2b", description: "Google Gemma 2 (2B)", size: "1.6GB" },
  { name: "phi3", description: "Microsoft Phi-3 (3.8B)", size: "2.2GB" },
  { name: "codellama", description: "Code Llama (7B)", size: "3.8GB" },
  { name: "deepseek-coder-v2", description: "DeepSeek Coder V2", size: "8.9GB" },
  { name: "nomic-embed-text", description: "Nomic Embed (Embedding)", size: "274MB" },
  { name: "mxbai-embed-large", description: "MixedBread Embed (Embedding)", size: "670MB" },
] as const

/**
 * Format bytes to human readable size
 */
export function formatModelSize(bytes: number): string {
  if (bytes === 0) return "0 B"
  const k = 1024
  const sizes = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}

/**
 * Format pull progress percentage
 */
export function formatPullProgress(progress: OllamaPullProgress): {
  percentage: number
  text: string
} {
  if (!progress.total || !progress.completed) {
    return { percentage: 0, text: progress.status }
  }

  const percentage = Math.round((progress.completed / progress.total) * 100)
  const completedStr = formatModelSize(progress.completed)
  const totalStr = formatModelSize(progress.total)

  return {
    percentage,
    text: `${progress.status} - ${completedStr} / ${totalStr} (${percentage}%)`,
  }
}

/**
 * Parse model name to extract base name and tag
 */
export function parseModelName(fullName: string): { name: string; tag: string } {
  const parts = fullName.split(":")
  return {
    name: parts[0],
    tag: parts[1] || "latest",
  }
}
