/**
 * Find Relevant Content Utility
 *
 * High-level API for finding relevant content from embeddings
 * using AI SDK's embed and cosineSimilarity functions.
 */

import { embed, embedMany } from "ai"
import type { EmbeddingModel } from "ai"
import { cosineSimilarity } from "@/lib/ai/embedding/embedding"

export interface DocumentWithEmbedding {
  id: string
  content: string
  embedding: number[]
  metadata?: Record<string, unknown>
}

export interface RelevantContent {
  id: string
  content: string
  similarity: number
  metadata?: Record<string, unknown>
}

export interface FindRelevantOptions {
  /** Embedding model to use for query */
  embeddingModel: EmbeddingModel
  /** Minimum similarity threshold (0-1) */
  similarityThreshold?: number
  /** Maximum number of results */
  topK?: number
  /** Maximum retries for embedding generation */
  maxRetries?: number
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal
}

/**
 * Find relevant content from a collection of documents
 *
 * @example
 * ```typescript
 * import { openai } from '@ai-sdk/openai';
 *
 * const results = await findRelevantContent(
 *   'What is machine learning?',
 *   documents,
 *   {
 *     embeddingModel: openai.embedding('text-embedding-3-small'),
 *     similarityThreshold: 0.5,
 *     topK: 5,
 *   }
 * );
 * ```
 */
export async function findRelevantContent(
  query: string,
  documents: DocumentWithEmbedding[],
  options: FindRelevantOptions
): Promise<RelevantContent[]> {
  const {
    embeddingModel,
    similarityThreshold = 0.5,
    topK = 5,
    maxRetries = 2,
    abortSignal,
  } = options

  if (documents.length === 0) {
    return []
  }

  // Generate query embedding using AI SDK
  const { embedding: queryEmbedding } = await embed({
    model: embeddingModel,
    value: query,
    maxRetries,
    abortSignal,
  })

  // Calculate similarities and filter/sort results
  return findRelevantContentWithEmbedding(queryEmbedding, documents, { similarityThreshold, topK })
}

/**
 * Find relevant content using pre-computed query embedding
 * Useful when you've already generated the query embedding
 */
export function findRelevantContentWithEmbedding(
  queryEmbedding: number[],
  documents: DocumentWithEmbedding[],
  options: {
    similarityThreshold?: number
    topK?: number
  } = {}
): RelevantContent[] {
  const { similarityThreshold = 0.5, topK = 5 } = options

  return documents
    .map((doc) => ({
      id: doc.id,
      content: doc.content,
      similarity: cosineSimilarity(queryEmbedding, doc.embedding),
      metadata: doc.metadata,
    }))
    .filter((r) => r.similarity >= similarityThreshold)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK)
}

/**
 * Batch find relevant content for multiple queries
 * More efficient than calling findRelevantContent multiple times
 *
 * @example
 * ```typescript
 * const results = await batchFindRelevantContent(
 *   ['query1', 'query2', 'query3'],
 *   documents,
 *   { embeddingModel, topK: 3 }
 * );
 *
 * for (const [query, relevant] of results) {
 *   console.log(`Query: ${query}, Found: ${relevant.length} results`);
 * }
 * ```
 */
export async function batchFindRelevantContent(
  queries: string[],
  documents: DocumentWithEmbedding[],
  options: FindRelevantOptions
): Promise<Map<string, RelevantContent[]>> {
  const {
    embeddingModel,
    similarityThreshold = 0.5,
    topK = 5,
    maxRetries = 2,
    abortSignal,
  } = options

  if (queries.length === 0 || documents.length === 0) {
    return new Map()
  }

  // Generate all query embeddings at once using AI SDK
  const { embeddings: queryEmbeddings } = await embedMany({
    model: embeddingModel,
    values: queries,
    maxRetries,
    abortSignal,
  })

  // Find relevant content for each query
  const results = new Map<string, RelevantContent[]>()

  for (let i = 0; i < queries.length; i++) {
    const relevant = findRelevantContentWithEmbedding(queryEmbeddings[i], documents, {
      similarityThreshold,
      topK,
    })
    results.set(queries[i], relevant)
  }

  return results
}

/**
 * Find the single most relevant document for a query
 * Returns null if no document meets the similarity threshold
 */
export async function findMostRelevant(
  query: string,
  documents: DocumentWithEmbedding[],
  options: Omit<FindRelevantOptions, "topK">
): Promise<RelevantContent | null> {
  const results = await findRelevantContent(query, documents, {
    ...options,
    topK: 1,
  })
  return results[0] ?? null
}

/**
 * Check if any document is relevant to the query
 * Useful for quick relevance checks without retrieving all results
 */
export async function hasRelevantContent(
  query: string,
  documents: DocumentWithEmbedding[],
  options: Omit<FindRelevantOptions, "topK">
): Promise<boolean> {
  const result = await findMostRelevant(query, documents, options)
  return result !== null
}

/**
 * Group documents by similarity ranges
 * Useful for understanding the distribution of relevance scores
 */
export function groupBySimilarity(
  results: RelevantContent[],
  ranges: { label: string; min: number; max: number }[] = [
    { label: "high", min: 0.8, max: 1.0 },
    { label: "medium", min: 0.6, max: 0.8 },
    { label: "low", min: 0.4, max: 0.6 },
  ]
): Record<string, RelevantContent[]> {
  const groups: Record<string, RelevantContent[]> = {}

  for (const range of ranges) {
    groups[range.label] = results.filter(
      (r) => r.similarity >= range.min && r.similarity < range.max
    )
  }

  return groups
}
