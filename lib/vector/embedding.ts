/**
 * Embedding Service - unified provider adapter for vector and RAG chains.
 */

import {
  generateEmbedding as generateAiEmbedding,
  generateEmbeddings as generateAiEmbeddings,
  cosineSimilarity as cosineSimilarityAi,
} from "@/lib/ai/embedding/embedding"
import type { ProviderName } from "@/types/provider"
import type { TransformersErrorCode } from "@/types/transformers"

export type EmbeddingProvider = "openai" | "google" | "cohere" | "mistral" | "transformersjs"

export interface EmbeddingModelConfig {
  provider: EmbeddingProvider
  model: string
  dimensions?: number
}

export const DEFAULT_EMBEDDING_MODELS: Record<EmbeddingProvider, EmbeddingModelConfig> = {
  openai: {
    provider: "openai",
    model: "text-embedding-3-small",
    dimensions: 1536,
  },
  google: {
    provider: "google",
    model: "text-embedding-004",
    dimensions: 768,
  },
  cohere: {
    provider: "cohere",
    model: "embed-english-v3.0",
    dimensions: 1024,
  },
  mistral: {
    provider: "mistral",
    model: "mistral-embed",
    dimensions: 1024,
  },
  transformersjs: {
    provider: "transformersjs",
    model: "Xenova/all-MiniLM-L6-v2",
    dimensions: 384,
  },
}

export interface EmbeddingResult {
  embedding: number[]
  model: string
  provider: EmbeddingProvider
}

export interface BatchEmbeddingResult {
  embeddings: number[][]
  model: string
  provider: EmbeddingProvider
}

export const TRANSFORMERS_RUNTIME_ERROR_CODE: TransformersErrorCode = "runtime_unavailable"
export const TRANSFORMERS_RUNTIME_ERROR_MESSAGE =
  "Transformers.js embeddings require a browser runtime with Web Workers. Use a cloud embedding provider or run this flow in the browser."

const PROVIDER_MAP: Record<Exclude<EmbeddingProvider, "transformersjs">, ProviderName> = {
  openai: "openai",
  google: "google",
  cohere: "cohere",
  mistral: "mistral",
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
  return provider !== "transformersjs"
}

export function getEmbeddingApiKey(
  provider: EmbeddingProvider,
  providerSettings: Record<string, { apiKey?: string }>
): string | null {
  if (provider === "transformersjs") return ""

  const mappedProvider = PROVIDER_MAP[provider]
  return providerSettings[mappedProvider]?.apiKey || null
}

export function resolveEmbeddingApiKey(
  provider: EmbeddingProvider,
  providerSettings: Record<string, { apiKey?: string }>
): string {
  return getEmbeddingApiKey(provider, providerSettings) || ""
}

export function isEmbeddingProviderConfigured(
  provider: EmbeddingProvider,
  providerSettings: Record<string, { apiKey?: string }>
): boolean {
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
  })

  return {
    embedding: result.embedding,
    model: config.model,
    provider: config.provider,
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
  })

  return {
    embeddings: result.embeddings,
    model: config.model,
    provider: config.provider,
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
