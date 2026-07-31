/**
 * Embedding Utilities - Enhanced embedding functions for AI SDK
 *
 * Provides utilities for text embeddings including:
 * - Batch embedding with parallel processing
 * - Cosine similarity calculation
 * - Embedding caching
 * - Similarity search
 *
 * Based on AI SDK documentation:
 * https://ai-sdk.dev/docs/ai-sdk-core/embeddings
 */

import { embed, embedMany, cosineSimilarity } from "ai"
import type { EmbeddingModel } from "ai"

// Re-export core functions
export { embed, embedMany, cosineSimilarity }

/**
 * Embedding result with metadata
 */
export interface EmbeddingResult {
  /** The embedding vector */
  embedding: number[]
  /** The original text */
  text: string
  /** Token count used */
  tokens?: number
}

/**
 * Batch embedding result
 */
export interface BatchEmbeddingResult {
  /** Array of embeddings in same order as input */
  embeddings: number[][]
  /** Total tokens used */
  totalTokens: number
  /** Time taken in ms */
  durationMs: number
}

/**
 * Similarity result
 */
export interface SimilarityResult {
  /** The text that was compared */
  text: string
  /** The embedding index */
  index: number
  /** Similarity score (0-1) */
  similarity: number
}

/**
 * Embedding cache interface
 */
export interface EmbeddingCache {
  get: (text: string) => Promise<number[] | null>
  set: (text: string, embedding: number[]) => Promise<void>
  has: (text: string) => Promise<boolean>
}

/**
 * Create an in-memory embedding cache
 */
export function createInMemoryEmbeddingCache(maxSize: number = 1000): EmbeddingCache {
  const cache = new Map<string, number[]>()

  return {
    async get(text: string): Promise<number[] | null> {
      return cache.get(text) ?? null
    },
    async set(text: string, embedding: number[]): Promise<void> {
      // Evict oldest if at capacity
      if (cache.size >= maxSize) {
        const firstKey = cache.keys().next().value
        if (firstKey) cache.delete(firstKey)
      }
      cache.set(text, embedding)
    },
    async has(text: string): Promise<boolean> {
      return cache.has(text)
    },
  }
}

/**
 * Options for batch embedding
 */
export interface BatchEmbedOptions {
  /** Maximum parallel API calls */
  maxParallelCalls?: number
  /** Embedding cache to use */
  cache?: EmbeddingCache
  /** Maximum retries per batch */
  maxRetries?: number
  /** Abort signal */
  abortSignal?: AbortSignal
}

/**
 * Embed multiple texts with caching and parallel processing
 */
export async function embedBatch(
  model: EmbeddingModel,
  texts: string[],
  options?: BatchEmbedOptions
): Promise<BatchEmbeddingResult> {
  const { maxParallelCalls = 5, cache, maxRetries = 2, abortSignal } = options || {}

  const startTime = Date.now()
  const embeddings: number[][] = new Array(texts.length)
  const textsToEmbed: { text: string; index: number }[] = []
  let totalTokens = 0

  // Check cache for existing embeddings
  if (cache) {
    for (let i = 0; i < texts.length; i++) {
      const cached = await cache.get(texts[i])
      if (cached) {
        embeddings[i] = cached
      } else {
        textsToEmbed.push({ text: texts[i], index: i })
      }
    }
  } else {
    textsToEmbed.push(...texts.map((text, index) => ({ text, index })))
  }

  // Embed remaining texts
  if (textsToEmbed.length > 0) {
    const values = textsToEmbed.map((t) => t.text)

    const result = await embedMany({
      model,
      values,
      maxRetries,
      abortSignal,
      maxParallelCalls,
    })

    // Map results back to original indices
    for (let i = 0; i < textsToEmbed.length; i++) {
      const originalIndex = textsToEmbed[i].index
      embeddings[originalIndex] = result.embeddings[i]

      // Cache the embedding
      if (cache) {
        await cache.set(textsToEmbed[i].text, result.embeddings[i])
      }
    }

    totalTokens = result.usage?.tokens ?? 0
  }

  return {
    embeddings,
    totalTokens,
    durationMs: Date.now() - startTime,
  }
}

/**
 * Find most similar texts from a corpus
 */
export async function findSimilar(
  model: EmbeddingModel,
  query: string,
  corpus: string[],
  options?: {
    /** Number of results to return */
    topK?: number
    /** Minimum similarity threshold */
    threshold?: number
    /** Pre-computed corpus embeddings */
    corpusEmbeddings?: number[][]
    /** Embedding cache */
    cache?: EmbeddingCache
  }
): Promise<SimilarityResult[]> {
  const { topK = 5, threshold = 0, corpusEmbeddings, cache } = options || {}

  // Get query embedding
  const queryResult = await embed({
    model,
    value: query,
  })
  const queryEmbedding = queryResult.embedding

  // Get or compute corpus embeddings
  let embeddings = corpusEmbeddings
  if (!embeddings) {
    const batchResult = await embedBatch(model, corpus, { cache })
    embeddings = batchResult.embeddings
  }

  // Calculate similarities
  const results: SimilarityResult[] = []
  for (let i = 0; i < corpus.length; i++) {
    const similarity = cosineSimilarity(queryEmbedding, embeddings[i])
    if (similarity >= threshold) {
      results.push({
        text: corpus[i],
        index: i,
        similarity,
      })
    }
  }

  // Sort by similarity and return top K
  results.sort((a, b) => b.similarity - a.similarity)
  return results.slice(0, topK)
}

/**
 * Calculate pairwise similarity matrix
 */
export function calculateSimilarityMatrix(embeddings: number[][]): number[][] {
  const n = embeddings.length
  const matrix: number[][] = Array(n)
    .fill(null)
    .map(() => Array(n).fill(0))

  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      const similarity = cosineSimilarity(embeddings[i], embeddings[j])
      matrix[i][j] = similarity
      matrix[j][i] = similarity
    }
  }

  return matrix
}

/**
 * Cluster texts by similarity
 */
export function clusterBySimilarity(
  embeddings: number[][],
  texts: string[],
  threshold: number = 0.8
): string[][] {
  const n = embeddings.length
  const visited = new Set<number>()
  const clusters: string[][] = []

  for (let i = 0; i < n; i++) {
    if (visited.has(i)) continue

    const cluster: string[] = [texts[i]]
    visited.add(i)

    for (let j = i + 1; j < n; j++) {
      if (visited.has(j)) continue

      const similarity = cosineSimilarity(embeddings[i], embeddings[j])
      if (similarity >= threshold) {
        cluster.push(texts[j])
        visited.add(j)
      }
    }

    clusters.push(cluster)
  }

  return clusters
}

/**
 * Normalize an embedding vector to unit length
 */
export function normalizeEmbedding(embedding: number[]): number[] {
  const magnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0))
  if (magnitude === 0) return embedding
  return embedding.map((val) => val / magnitude)
}

/**
 * Calculate Euclidean distance between embeddings
 */
export function euclideanDistance(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error("Embeddings must have same dimensions")
  }
  return Math.sqrt(a.reduce((sum, val, i) => sum + Math.pow(val - b[i], 2), 0))
}

/**
 * Calculate dot product of embeddings
 */
export function dotProduct(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error("Embeddings must have same dimensions")
  }
  return a.reduce((sum, val, i) => sum + val * b[i], 0)
}

/**
 * Average multiple embeddings
 */
export function averageEmbeddings(embeddings: number[][]): number[] {
  if (embeddings.length === 0) return []

  const dimensions = embeddings[0].length
  const result = new Array(dimensions).fill(0)

  for (const embedding of embeddings) {
    for (let i = 0; i < dimensions; i++) {
      result[i] += embedding[i]
    }
  }

  return result.map((val) => val / embeddings.length)
}

/**
 * Reduce embedding dimensions using PCA (simple implementation)
 */
export function reduceEmbeddingDimensions(
  embeddings: number[][],
  targetDimensions: number
): number[][] {
  if (embeddings.length === 0) return []
  if (targetDimensions >= embeddings[0].length) return embeddings

  // Simple truncation - for proper PCA, use a library like ml-pca
  return embeddings.map((e) => e.slice(0, targetDimensions))
}

/**
 * Embedding model configuration
 */
export const EMBEDDING_MODELS = {
  openai: {
    "text-embedding-3-large": { dimensions: 3072 },
    "text-embedding-3-small": { dimensions: 1536 },
    "text-embedding-ada-002": { dimensions: 1536 },
  },
  google: {
    "gemini-embedding-001": { dimensions: 3072 },
    "text-embedding-004": { dimensions: 768 },
  },
  mistral: {
    "mistral-embed": { dimensions: 1024 },
  },
  cohere: {
    "embed-english-v3.0": { dimensions: 1024 },
    "embed-multilingual-v3.0": { dimensions: 1024 },
  },
} as const
