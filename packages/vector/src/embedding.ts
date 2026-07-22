/**
 * Embedding Service - unified provider adapter for vector and RAG chains.
 */

import {
  generateEmbedding as generateAiEmbedding,
  generateEmbeddings as generateAiEmbeddings,
  cosineSimilarity as cosineSimilarityAi,
} from "@cognia/provider-embedding/embedding"
import {
  RAG_EMBEDDING_PROVIDERS,
  getEmbeddingProviderDescriptor,
  embeddingProviderRequiresApiKey as catalogRequiresApiKey,
  type RagEmbeddingProvider,
} from "@cognia/provider-embedding/embedding-catalog"
import {
  validateBedrockConnectionSettings,
  type BedrockConnectionSettings,
  type ProviderName,
} from "@cognia/provider-types"
import { createBedrockSidecarEmbeddingModel } from "@/lib/claude/feature-call"
import type { TransformersErrorCode } from "@/types/transformers"

/**
 * Selectable embedding provider for the vector / RAG path. Aliases the
 * canonical catalog union so the adapter, the Twin types, and the settings
 * store all reference ONE list (previously redeclared and drifting).
 */
export type EmbeddingProvider = RagEmbeddingProvider

export interface EmbeddingModelConfig {
  provider: EmbeddingProvider
  model: string
  dimensions?: number
  /** Base URL for local engines (ollama/lmstudio/…) and proxy overrides. */
  baseURL?: string
  bedrock?: BedrockConnectionSettings
}

export const DEFAULT_EMBEDDING_MODELS = Object.fromEntries(
  RAG_EMBEDDING_PROVIDERS.map((id) => {
    const descriptor = getEmbeddingProviderDescriptor(id)
    return [
      id,
      { provider: id, model: descriptor.defaultModel, dimensions: descriptor.defaultDimensions },
    ]
  })
) as Record<EmbeddingProvider, EmbeddingModelConfig>

export interface EmbeddingResult {
  embedding: number[]
  model: string
  provider: EmbeddingProvider
  usage?: { tokens: number }
}

export interface BatchEmbeddingResult {
  embeddings: number[][]
  model: string
  provider: EmbeddingProvider
  usage?: { tokens: number }
}

export const TRANSFORMERS_RUNTIME_ERROR_CODE: TransformersErrorCode = "runtime_unavailable"
export const TRANSFORMERS_RUNTIME_ERROR_MESSAGE =
  "Transformers.js embeddings require a browser runtime with Web Workers. Use a cloud embedding provider or run this flow in the browser."

// Maps an embedding provider to the chat-provider settings key its API key is
// shared from. Omitted providers have no shared chat-settings key: local
// engines need no key, and voyage/transformersjs supply their key (or none)
// directly through the embedding config.
const PROVIDER_MAP: Partial<Record<EmbeddingProvider, ProviderName>> = {
  openai: "openai",
  google: "google",
  cohere: "cohere",
  mistral: "mistral",
  ollama: "ollama",
  lmstudio: "lmstudio",
  llamacpp: "llamacpp",
  vllm: "vllm",
  localai: "localai",
  jan: "jan",
  "amazon-bedrock": "bedrock",
}

interface EmbeddingProviderSettings {
  apiKey?: string
  bedrock?: BedrockConnectionSettings
}

export class EmbeddingProviderRuntimeError extends Error {
  readonly code: TransformersErrorCode

  constructor(message: string, code: TransformersErrorCode = TRANSFORMERS_RUNTIME_ERROR_CODE) {
    super(message)
    this.name = "EmbeddingProviderRuntimeError"
    this.code = code
  }
}

export function embeddingProviderRequiresApiKey(provider: EmbeddingProvider): boolean {
  return catalogRequiresApiKey(provider)
}

export function getEmbeddingApiKey(
  provider: EmbeddingProvider,
  providerSettings: Record<string, EmbeddingProviderSettings>
): string | null {
  if (provider === "transformersjs") return ""

  const mappedProvider = PROVIDER_MAP[provider]
  if (!mappedProvider) return null
  const settings = providerSettings[mappedProvider]
  if (provider === "amazon-bedrock" && settings?.bedrock?.authMode === "api-key") {
    return settings.bedrock.apiKey || settings.apiKey || null
  }
  return settings?.apiKey || null
}

export function resolveEmbeddingApiKey(
  provider: EmbeddingProvider,
  providerSettings: Record<string, EmbeddingProviderSettings>
): string {
  return getEmbeddingApiKey(provider, providerSettings) || ""
}

export function isEmbeddingProviderConfigured(
  provider: EmbeddingProvider,
  providerSettings: Record<string, EmbeddingProviderSettings>
): boolean {
  if (provider === "amazon-bedrock") {
    const settings = providerSettings.bedrock?.bedrock
    return !!settings && validateBedrockConnectionSettings(settings).valid
  }
  if (!embeddingProviderRequiresApiKey(provider)) {
    return true
  }

  return Boolean(resolveEmbeddingApiKey(provider, providerSettings))
}

export function isTransformersRuntimeAvailable(): boolean {
  return typeof window !== "undefined" && typeof Worker !== "undefined"
}

export function assertEmbeddingProviderRuntimeAvailable(provider: EmbeddingProvider): void {
  if (provider === "transformersjs" && !isTransformersRuntimeAvailable()) {
    throw new EmbeddingProviderRuntimeError(TRANSFORMERS_RUNTIME_ERROR_MESSAGE)
  }
}

export function isTransformersRuntimeUnavailableError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false
  }

  const maybeCode = "code" in error ? String((error as { code?: unknown }).code || "") : ""
  const maybeMessage =
    "message" in error ? String((error as { message?: unknown }).message || "") : String(error)

  return (
    maybeCode === TRANSFORMERS_RUNTIME_ERROR_CODE ||
    maybeMessage.includes(TRANSFORMERS_RUNTIME_ERROR_MESSAGE)
  )
}

function assertEmbeddingExecutionInput(config: EmbeddingModelConfig, apiKey: string): void {
  assertEmbeddingProviderRuntimeAvailable(config.provider)

  if (embeddingProviderRequiresApiKey(config.provider) && !apiKey) {
    throw new Error(`Embedding provider ${config.provider} requires an API key`)
  }
}

/**
 * Generate embedding for a single text.
 */
export async function generateEmbedding(
  text: string,
  config: EmbeddingModelConfig,
  apiKey: string
): Promise<EmbeddingResult> {
  assertEmbeddingExecutionInput(config, apiKey)

  if (config.provider === "transformersjs") {
    const { getTransformersManager } = await import("@/lib/ai/transformers/transformers-manager")
    const manager = getTransformersManager()
    const result = await manager.generateEmbedding(text, config.model)
    return {
      embedding: result.embedding,
      model: config.model,
      provider: config.provider,
    }
  }

  const result = await generateAiEmbedding(text, {
    provider: config.provider,
    model: config.model,
    apiKey,
    dimensions: config.dimensions,
    baseURL: config.baseURL,
    bedrock: config.bedrock,
    bedrockModel:
      config.provider === "amazon-bedrock" && config.bedrock?.authMode === "default-chain"
        ? createBedrockSidecarEmbeddingModel({
            modelId: config.model,
            providerId: "bedrock",
            credentials: {
              protocol: "bedrock",
              bedrockAuthMode: "default-chain",
              region: config.bedrock.region,
              baseURL: config.bedrock.baseURL,
              profile: config.bedrock.profile,
              roleArn: config.bedrock.roleArn,
              roleSessionName: config.bedrock.roleSessionName,
            },
          })
        : undefined,
  })

  return {
    embedding: result.embedding,
    model: config.model,
    provider: config.provider,
    ...(result.usage ? { usage: result.usage } : {}),
  }
}

/**
 * Generate embeddings for multiple texts.
 */
export async function generateEmbeddings(
  texts: string[],
  config: EmbeddingModelConfig,
  apiKey: string
): Promise<BatchEmbeddingResult> {
  assertEmbeddingExecutionInput(config, apiKey)

  if (config.provider === "transformersjs") {
    const { getTransformersManager } = await import("@/lib/ai/transformers/transformers-manager")
    const manager = getTransformersManager()
    const result = await manager.generateEmbeddings(texts, config.model)
    return {
      embeddings: result.embeddings,
      model: config.model,
      provider: config.provider,
    }
  }

  const result = await generateAiEmbeddings(texts, {
    provider: config.provider,
    model: config.model,
    apiKey,
    dimensions: config.dimensions,
    baseURL: config.baseURL,
    bedrock: config.bedrock,
    bedrockModel:
      config.provider === "amazon-bedrock" && config.bedrock?.authMode === "default-chain"
        ? createBedrockSidecarEmbeddingModel({
            modelId: config.model,
            providerId: "bedrock",
            credentials: {
              protocol: "bedrock",
              bedrockAuthMode: "default-chain",
              region: config.bedrock.region,
              baseURL: config.bedrock.baseURL,
              profile: config.bedrock.profile,
              roleArn: config.bedrock.roleArn,
              roleSessionName: config.bedrock.roleSessionName,
            },
          })
        : undefined,
  })

  return {
    embeddings: result.embeddings,
    model: config.model,
    provider: config.provider,
    ...(result.usage ? { usage: result.usage } : {}),
  }
}

/**
 * Calculate cosine similarity between two embeddings.
 */
export function calculateSimilarity(a: number[], b: number[]): number {
  return cosineSimilarityAi(a, b)
}

/**
 * Find most similar embeddings from a collection.
 */
export function findMostSimilar(
  queryEmbedding: number[],
  embeddings: { id: string; embedding: number[] }[],
  topK: number = 5,
  threshold: number = 0.5
): { id: string; similarity: number }[] {
  const similarities = embeddings.map((item) => ({
    id: item.id,
    similarity: calculateSimilarity(queryEmbedding, item.embedding),
  }))

  return similarities
    .filter((item) => item.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK)
}

/**
 * Normalize text for embedding (clean whitespace, etc.).
 */
export function normalizeTextForEmbedding(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\n+/g, " ").trim()
}
