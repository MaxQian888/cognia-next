/**
 * Ollama API type definitions
 * Types for local model management via Ollama
 */
/**
 * Ollama model details
 */
interface OllamaModelDetails {
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
interface OllamaModel {
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
interface OllamaServerStatus {
  connected: boolean
  version?: string
  models_count: number
}
/**
 * Ollama model pull progress event
 */
interface OllamaPullProgress {
  status: string
  digest?: string
  total?: number
  completed?: number
  model: string
}
/**
 * Ollama running model info
 */
interface OllamaRunningModel {
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
declare const OLLAMA_CAPABILITIES: readonly [
  "completion",
  "tools",
  "insert",
  "vision",
  "embedding",
  "thinking",
  "image",
  "audio",
]
type OllamaCapability = (typeof OLLAMA_CAPABILITIES)[number]
/**
 * Ollama model detailed info (from show endpoint)
 */
interface OllamaModelInfo {
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
interface OllamaModelCapabilities {
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
declare const OLLAMA_EMBEDDING_MODELS: readonly [
  "nomic-embed-text",
  "mxbai-embed-large",
  "snowflake-arctic-embed",
  "all-minilm",
  "bge-m3",
  "bge-large",
]
type OllamaEmbeddingModel = (typeof OLLAMA_EMBEDDING_MODELS)[number]
/**
 * Popular Ollama models for quick pull
 */
declare const POPULAR_OLLAMA_MODELS: readonly [
  {
    readonly name: "llama3.2"
    readonly description: "Meta Llama 3.2 (3B)"
    readonly size: "2.0GB"
  },
  {
    readonly name: "llama3.2:1b"
    readonly description: "Meta Llama 3.2 (1B)"
    readonly size: "1.3GB"
  },
  {
    readonly name: "llama3.3"
    readonly description: "Meta Llama 3.3 (70B)"
    readonly size: "43GB"
  },
  {
    readonly name: "qwen2.5"
    readonly description: "Qwen 2.5 (7B)"
    readonly size: "4.7GB"
  },
  {
    readonly name: "qwen2.5:3b"
    readonly description: "Qwen 2.5 (3B)"
    readonly size: "1.9GB"
  },
  {
    readonly name: "qwen2.5-coder"
    readonly description: "Qwen 2.5 Coder (7B)"
    readonly size: "4.7GB"
  },
  {
    readonly name: "mistral"
    readonly description: "Mistral (7B)"
    readonly size: "4.1GB"
  },
  {
    readonly name: "mixtral"
    readonly description: "Mixtral 8x7B"
    readonly size: "26GB"
  },
  {
    readonly name: "gemma2"
    readonly description: "Google Gemma 2 (9B)"
    readonly size: "5.4GB"
  },
  {
    readonly name: "gemma2:2b"
    readonly description: "Google Gemma 2 (2B)"
    readonly size: "1.6GB"
  },
  {
    readonly name: "phi3"
    readonly description: "Microsoft Phi-3 (3.8B)"
    readonly size: "2.2GB"
  },
  {
    readonly name: "codellama"
    readonly description: "Code Llama (7B)"
    readonly size: "3.8GB"
  },
  {
    readonly name: "deepseek-coder-v2"
    readonly description: "DeepSeek Coder V2"
    readonly size: "8.9GB"
  },
  {
    readonly name: "nomic-embed-text"
    readonly description: "Nomic Embed (Embedding)"
    readonly size: "274MB"
  },
  {
    readonly name: "mxbai-embed-large"
    readonly description: "MixedBread Embed (Embedding)"
    readonly size: "670MB"
  },
]
/**
 * Format bytes to human readable size
 */
declare function formatModelSize(bytes: number): string
/**
 * Format pull progress percentage
 */
declare function formatPullProgress(progress: OllamaPullProgress): {
  percentage: number
  text: string
}
/**
 * Parse model name to extract base name and tag
 */
declare function parseModelName(fullName: string): {
  name: string
  tag: string
}

export {
  OLLAMA_CAPABILITIES,
  OLLAMA_EMBEDDING_MODELS,
  type OllamaCapability,
  type OllamaEmbeddingModel,
  type OllamaModel,
  type OllamaModelCapabilities,
  type OllamaModelDetails,
  type OllamaModelInfo,
  type OllamaPullProgress,
  type OllamaRunningModel,
  type OllamaServerStatus,
  POPULAR_OLLAMA_MODELS,
  formatModelSize,
  formatPullProgress,
  parseModelName,
}
