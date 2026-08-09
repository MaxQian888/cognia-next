/**
 * Embedding utilities using AI SDK
 *
 * Features:
 * - Multi-provider support (OpenAI, Google, Cohere, Mistral, Amazon Bedrock, Azure)
 * - In-memory caching for repeated embeddings
 * - Batch processing with automatic chunking
 * - Parallel request control with maxParallelCalls
 * - Similarity calculations using AI SDK cosineSimilarity
 * - Provider-specific options support
 */

import { embed, embedMany, cosineSimilarity as aiCosineSimilarity } from "ai"
import type { BedrockConnectionSettings } from "@cognia/provider-types"
import type { EmbeddingModelV3 } from "@ai-sdk/provider"
import type { ProviderName } from "@cognia/provider-types"
import {
  generateOllamaEmbedding,
  generateOllamaEmbeddings,
} from "@cognia/provider-core/providers/ollama"
import {
  DEFAULT_LOCAL_EMBEDDING_MODEL,
  isOpenAICompatibleEmbeddingProvider,
  resolveLocalEmbeddingBaseURL,
} from "./local-embedding"

// Re-export cosineSimilarity from AI SDK for consistent usage
export { cosineSimilarity as aiCosineSimilarity } from "ai"

/**
 * Voyage exposes an OpenAI-compatible `/v1/embeddings` endpoint, so it resolves
 * through the OpenAI client with this base URL when the user hasn't overridden it.
 */
export const VOYAGE_EMBEDDING_BASE_URL = "https://api.voyageai.com/v1"

/**
 * Embedding-specific provider names (superset of chat providers)
 * Includes providers that only support embeddings
 */
export type EmbeddingProviderName =
  ProviderName | "azure" | "amazon-bedrock" | "voyage" | "transformersjs"

/**
 * Provider-specific options for embedding models
 */
export interface EmbeddingProviderOptions {
  /** OpenAI/Azure specific options */
  openai?: {
    dimensions?: number
    user?: string
  }
  /** Google specific options */
  google?: {
    outputDimensionality?: number
    taskType?:
      | "RETRIEVAL_DOCUMENT"
      | "RETRIEVAL_QUERY"
      | "SEMANTIC_SIMILARITY"
      | "CLASSIFICATION"
      | "CLUSTERING"
  }
  /** Cohere specific options */
  cohere?: {
    inputType?: "search_document" | "search_query" | "classification" | "clustering"
    truncate?: "NONE" | "START" | "END"
  }
  /** Amazon Bedrock specific options */
  bedrock?: {
    dimensions?: number
    normalize?: boolean
  }
}

export interface EmbeddingConfig {
  provider: EmbeddingProviderName
  model?: string
  apiKey?: string
  baseURL?: string // For Ollama and custom providers
  dimensions?: number
  cache?: EmbeddingCache
  /** Maximum number of parallel requests for batch embedding */
  maxParallelCalls?: number
  /** Maximum number of retries (default: 2) */
  maxRetries?: number
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal
  /** Provider-specific options */
  providerOptions?: EmbeddingProviderOptions
  /** Error callback */
  onError?: (error: Error) => void
  // Azure specific
  resourceName?: string
  apiVersion?: string
  // Amazon Bedrock specific
  region?: string
  bedrock?: BedrockConnectionSettings
  /** Node-side proxy model for AWS default-chain authentication. */
  bedrockModel?: EmbeddingModelV3
}

/**
 * Simple embedding cache interface
 */
export interface EmbeddingCache {
  get(key: string): number[] | undefined
  set(key: string, embedding: number[]): void
  has(key: string): boolean
  clear(): void
  size(): number
}

/**
 * Create an in-memory LRU cache for embeddings
 */
export function createEmbeddingCache(maxSize: number = 1000): EmbeddingCache {
  const cache = new Map<string, { embedding: number[]; accessTime: number }>()

  const evictOldest = () => {
    if (cache.size <= maxSize) return

    let oldestKey: string | null = null
    let oldestTime = Infinity

    for (const [key, value] of cache.entries()) {
      if (value.accessTime < oldestTime) {
        oldestTime = value.accessTime
        oldestKey = key
      }
    }

    if (oldestKey) {
      cache.delete(oldestKey)
    }
  }

  return {
    get(key: string): number[] | undefined {
      const entry = cache.get(key)
      if (entry) {
        entry.accessTime = Date.now()
        return entry.embedding
      }
      return undefined
    },
    set(key: string, embedding: number[]): void {
      cache.set(key, { embedding, accessTime: Date.now() })
      evictOldest()
    },
    has(key: string): boolean {
      return cache.has(key)
    },
    clear(): void {
      cache.clear()
    },
    size(): number {
      return cache.size
    },
  }
}

/**
 * Generate cache key from text and config
 */
function getCacheKey(text: string, config: EmbeddingConfig): string {
  return `${config.provider}:${config.model || "default"}:${text.slice(0, 100)}:${text.length}`
}

export interface EmbeddingResult {
  embedding: number[]
  usage?: {
    tokens: number
  }
}

export interface BatchEmbeddingResult {
  embeddings: number[][]
  usage?: {
    tokens: number
  }
}

/**
 * Default embedding models for each provider
 */
export const defaultEmbeddingModels: Partial<Record<EmbeddingProviderName, string>> = {
  openai: "text-embedding-3-small",
  google: "text-embedding-004",
  cohere: "embed-english-v3.0",
  mistral: "mistral-embed",
  ollama: "nomic-embed-text",
  voyage: "voyage-3",
  // Additional embedding-only providers
  azure: "text-embedding-3-small",
  "amazon-bedrock": "amazon.titan-embed-text-v2:0",
}

/**
 * Cohere input types for different use cases
 */
export type CohereInputType = "search_document" | "search_query" | "classification" | "clustering"

/**
 * Get embedding model instance based on provider
 */
async function getEmbeddingModel(config: EmbeddingConfig) {
  const { provider, model, apiKey, baseURL } = config

  // Local OpenAI-compatible engines (lmstudio/llamacpp/vllm/localai/jan) embed
  // through the OpenAI client pointed at their /v1 endpoint. Ollama is handled
  // earlier in generateEmbedding(s) via its native API, so it never reaches here.
  if (isOpenAICompatibleEmbeddingProvider(provider)) {
    const { createOpenAI } = await import("@ai-sdk/openai")
    const openai = createOpenAI({
      apiKey: apiKey || "local",
      baseURL: resolveLocalEmbeddingBaseURL(provider, baseURL),
    })
    return openai.embedding(model || DEFAULT_LOCAL_EMBEDDING_MODEL)
  }

  switch (provider) {
    case "openai": {
      const { createOpenAI } = await import("@ai-sdk/openai")
      const openai = createOpenAI({ apiKey, baseURL })
      const modelId = model || defaultEmbeddingModels.openai || "text-embedding-3-small"
      return openai.embedding(modelId)
    }
    case "google": {
      const { createGoogle } = await import("@ai-sdk/google")
      const google = createGoogle({ apiKey, baseURL })
      const modelId = model || defaultEmbeddingModels.google || "text-embedding-004"
      return google.embeddingModel(modelId)
    }
    case "cohere": {
      const { createCohere } = await import("@ai-sdk/cohere")
      const cohere = createCohere({ apiKey, baseURL })
      const modelId = model || defaultEmbeddingModels.cohere || "embed-english-v3.0"
      return cohere.embedding(modelId)
    }
    case "mistral": {
      const { createMistral } = await import("@ai-sdk/mistral")
      const mistral = createMistral({ apiKey, baseURL })
      const modelId = model || defaultEmbeddingModels.mistral || "mistral-embed"
      return mistral.embedding(modelId)
    }
    case "voyage": {
      // Voyage exposes an OpenAI-compatible /v1/embeddings endpoint.
      const { createOpenAI } = await import("@ai-sdk/openai")
      const voyage = createOpenAI({ apiKey, baseURL: baseURL || VOYAGE_EMBEDDING_BASE_URL })
      const modelId = model || defaultEmbeddingModels.voyage || "voyage-3"
      return voyage.embedding(modelId)
    }
    case "amazon-bedrock": {
      const bedrock = config.bedrock
      if (bedrock?.authMode === "default-chain") {
        if (config.bedrockModel) return config.bedrockModel
        throw new Error("Bedrock default-chain embeddings require an injected sidecar model.")
      }
      const { createAmazonBedrock } = await import("@ai-sdk/amazon-bedrock")
      const client = createAmazonBedrock({
        ...(bedrock?.authMode === "api-key" || (!bedrock && apiKey)
          ? { apiKey: bedrock?.apiKey ?? apiKey }
          : {}),
        ...(bedrock?.authMode === "iam"
          ? {
              accessKeyId: bedrock.accessKeyId,
              secretAccessKey: bedrock.secretAccessKey,
              ...(bedrock.sessionToken ? { sessionToken: bedrock.sessionToken } : {}),
            }
          : {}),
        ...(bedrock?.region || config.region ? { region: bedrock?.region ?? config.region } : {}),
        ...(baseURL ? { baseURL } : bedrock?.baseURL ? { baseURL: bedrock.baseURL } : {}),
      })
      return client.embedding(
        model || defaultEmbeddingModels["amazon-bedrock"] || "amazon.titan-embed-text-v2:0"
      )
    }
    case "azure":
      throw new Error(
        `Embedding provider "${provider}" requires the @ai-sdk/azure package, which is not bundled. Use openai/google/cohere/mistral/voyage/amazon-bedrock or a local provider (ollama, lmstudio, llamacpp, vllm, localai, jan).`
      )
    default:
      throw new Error(`Embedding not supported for provider: ${provider}`)
  }
}

/**
 * Generate embedding for a single text (with caching support)
 */
export async function generateEmbedding(
  text: string,
  config: EmbeddingConfig
): Promise<EmbeddingResult> {
  // Check cache first
  if (config.cache) {
    const cacheKey = getCacheKey(text, config)
    const cached = config.cache.get(cacheKey)
    if (cached) {
      return { embedding: cached, usage: undefined }
    }
  }

  let embedding: number[]

  // Handle Ollama separately - uses different API
  if (config.provider === "ollama") {
    const baseURL = config.baseURL || "http://localhost:11434"
    const modelId = config.model || defaultEmbeddingModels.ollama || "nomic-embed-text"
    embedding = await generateOllamaEmbedding(baseURL, modelId, text)

    // Store in cache
    if (config.cache) {
      const cacheKey = getCacheKey(text, config)
      config.cache.set(cacheKey, embedding)
    }

    return { embedding, usage: undefined }
  }

  // Standard AI SDK providers
  const model = await getEmbeddingModel(config)

  try {
    const result = await embed({
      model,
      value: text,
      maxRetries: config.maxRetries ?? 2,
      abortSignal: config.abortSignal,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      providerOptions: config.providerOptions as any,
    })

    embedding = result.embedding

    // Store in cache
    if (config.cache) {
      const cacheKey = getCacheKey(text, config)
      config.cache.set(cacheKey, embedding)
    }

    return {
      embedding,
      usage: result.usage ? { tokens: result.usage.tokens } : undefined,
    }
  } catch (error) {
    config.onError?.(error instanceof Error ? error : new Error(String(error)))
    throw error
  }
}

/**
 * Generate embeddings for multiple texts (with caching support)
 */
export async function generateEmbeddings(
  texts: string[],
  config: EmbeddingConfig
): Promise<BatchEmbeddingResult> {
  // Check cache for each text
  const results: (number[] | null)[] = new Array(texts.length).fill(null)
  const textsToEmbed: { index: number; text: string }[] = []

  if (config.cache) {
    for (let i = 0; i < texts.length; i++) {
      const cacheKey = getCacheKey(texts[i], config)
      const cached = config.cache.get(cacheKey)
      if (cached) {
        results[i] = cached
      } else {
        textsToEmbed.push({ index: i, text: texts[i] })
      }
    }
  } else {
    texts.forEach((text, index) => textsToEmbed.push({ index, text }))
  }

  // If all cached, return immediately
  if (textsToEmbed.length === 0) {
    return {
      embeddings: results as number[][],
      usage: undefined,
    }
  }

  // Handle Ollama separately — one batched request, not one request per text.
  // This used to loop `generateOllamaEmbedding`, paying a full HTTP round-trip
  // per chunk; `/api/embed` takes the whole array in a single call.
  if (config.provider === "ollama") {
    const baseURL = config.baseURL || "http://localhost:11434"
    const modelId = config.model || defaultEmbeddingModels.ollama || "nomic-embed-text"

    const embeddings = await generateOllamaEmbeddings(
      baseURL,
      modelId,
      textsToEmbed.map((t) => t.text)
    )

    // `generateOllamaEmbeddings` guarantees positional alignment with its input
    // or throws, so indexing by position here is safe.
    textsToEmbed.forEach(({ index, text }, i) => {
      results[index] = embeddings[i]
      if (config.cache) {
        config.cache.set(getCacheKey(text, config), embeddings[i])
      }
    })

    return {
      embeddings: results as number[][],
      usage: undefined,
    }
  }

  // Generate embeddings for uncached texts using AI SDK
  const model = await getEmbeddingModel(config)

  try {
    const result = await embedMany({
      model,
      values: textsToEmbed.map((t) => t.text),
      maxRetries: config.maxRetries ?? 2,
      maxParallelCalls: config.maxParallelCalls ?? 5,
      abortSignal: config.abortSignal,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      providerOptions: config.providerOptions as any,
    })

    // Merge results and update cache
    for (let i = 0; i < textsToEmbed.length; i++) {
      const { index, text } = textsToEmbed[i]
      const embedding = result.embeddings[i]
      results[index] = embedding

      if (config.cache) {
        const cacheKey = getCacheKey(text, config)
        config.cache.set(cacheKey, embedding)
      }
    }

    return {
      embeddings: results as number[][],
      usage: result.usage ? { tokens: result.usage.tokens } : undefined,
    }
  } catch (error) {
    config.onError?.(error instanceof Error ? error : new Error(String(error)))
    throw error
  }
}

/**
 * Generate embeddings in batches to avoid API limits
 */
export async function generateEmbeddingsBatched(
  texts: string[],
  config: EmbeddingConfig,
  batchSize: number = 100
): Promise<BatchEmbeddingResult> {
  const allEmbeddings: number[][] = []
  let totalTokens = 0

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize)
    const result = await generateEmbeddings(batch, config)
    allEmbeddings.push(...result.embeddings)
    if (result.usage) {
      totalTokens += result.usage.tokens
    }
  }

  return {
    embeddings: allEmbeddings,
    usage: totalTokens > 0 ? { tokens: totalTokens } : undefined,
  }
}

/**
 * Calculate cosine similarity between two embeddings
 * Uses AI SDK's cosineSimilarity for consistency
 * @returns A number between -1 and 1, where 1 indicates identical vectors
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  return aiCosineSimilarity(a, b)
}

/**
 * Calculate euclidean distance between two embeddings
 */
export function euclideanDistance(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error("Embeddings must have the same length")
  }

  let sum = 0
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i]
    sum += diff * diff
  }

  return Math.sqrt(sum)
}

/**
 * Find the most similar embeddings from a list
 */
export function findMostSimilar(
  query: number[],
  candidates: { id: string; embedding: number[] }[],
  options?: {
    topK?: number
    threshold?: number
    metric?: "cosine" | "euclidean"
  }
): { id: string; score: number }[] {
  const { topK = 5, threshold = 0, metric = "cosine" } = options || {}

  const scored = candidates.map((candidate) => {
    const score =
      metric === "cosine"
        ? cosineSimilarity(query, candidate.embedding)
        : 1 / (1 + euclideanDistance(query, candidate.embedding)) // Convert distance to similarity

    return { id: candidate.id, score }
  })

  // Filter by threshold and sort by score
  return scored
    .filter((item) => item.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
}

/**
 * Normalize an embedding vector
 */
export function normalizeEmbedding(embedding: number[]): number[] {
  const magnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0))
  if (magnitude === 0) return embedding
  return embedding.map((val) => val / magnitude)
}

/**
 * Average multiple embeddings into one
 */
export function averageEmbeddings(embeddings: number[][]): number[] {
  if (embeddings.length === 0) {
    throw new Error("Cannot average empty embeddings array")
  }

  const length = embeddings[0].length
  const result = new Array(length).fill(0)

  for (const embedding of embeddings) {
    if (embedding.length !== length) {
      throw new Error("All embeddings must have the same length")
    }
    for (let i = 0; i < length; i++) {
      result[i] += embedding[i]
    }
  }

  return result.map((val) => val / embeddings.length)
}

/**
 * Embedding dimension info for common models
 */
export const embeddingDimensions: Record<string, number> = {
  // OpenAI models
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
  // Google models
  "text-embedding-004": 768,
  "gemini-embedding-001": 768,
  // Cohere models
  "embed-english-v3.0": 1024,
  "embed-multilingual-v3.0": 1024,
  "embed-english-light-v3.0": 384,
  "embed-multilingual-light-v3.0": 384,
  // Mistral models
  "mistral-embed": 1024,
  // Amazon Bedrock models
  "amazon.titan-embed-text-v2:0": 1024,
  "amazon.titan-embed-text-v1": 1536,
  // Azure (same as OpenAI)
  "azure-text-embedding-3-small": 1536,
  "azure-text-embedding-3-large": 3072,
}

/**
 * Get embedding dimension for a model
 */
export function getEmbeddingDimension(model: string): number | undefined {
  return embeddingDimensions[model]
}
