/**
 * RAG (Retrieval Augmented Generation) Service
 *
 * Features:
 * - Batch document indexing with progress callbacks
 * - Incremental updates (add/update/delete documents)
 * - Context retrieval with relevance scoring
 * - Configurable chunking strategies
 */

import { chunkDocument, type ChunkingOptions, type DocumentChunk } from "../embedding/chunking"
import {
  generateEmbedding,
  generateEmbeddings,
  findMostSimilar,
  type EmbeddingModelConfig,
} from "@/lib/vector/embedding"
import {
  getChromaClient,
  getOrCreateCollection,
  addDocuments,
  queryCollection,
  type ChromaConfig,
  type SearchResult,
} from "@/lib/vector/chroma-client"
import { loggers } from "@/lib/logger"

const log = loggers.ai

export interface RAGDocument {
  id: string
  content: string
  title?: string
  source?: string
  metadata?: Record<string, string | number | boolean>
}

export interface RAGConfig {
  chromaConfig: ChromaConfig
  chunkingOptions?: Partial<ChunkingOptions>
  topK?: number
  similarityThreshold?: number
  maxContextLength?: number
}

export interface RAGContext {
  documents: SearchResult[]
  query: string
  formattedContext: string
  totalTokensEstimate: number
}

export interface IndexingResult {
  documentId: string
  chunksCreated: number
  success: boolean
  error?: string
}

export interface BatchIndexingProgress {
  totalDocuments: number
  processedDocuments: number
  currentDocument?: string
  successCount: number
  errorCount: number
  percentage: number
}

export interface BatchIndexingOptions {
  onProgress?: (progress: BatchIndexingProgress) => void
  onDocumentComplete?: (result: IndexingResult) => void
  batchSize?: number
  continueOnError?: boolean
}

/**
 * Index a document into the vector database
 */
export async function indexDocument(
  collectionName: string,
  document: RAGDocument,
  config: RAGConfig
): Promise<IndexingResult> {
  try {
    const client = getChromaClient(config.chromaConfig)
    const collection = await getOrCreateCollection(client, collectionName)

    // Chunk the document
    const chunkResult = chunkDocument(document.content, config.chunkingOptions, document.id)

    if (chunkResult.chunks.length === 0) {
      return {
        documentId: document.id,
        chunksCreated: 0,
        success: false,
        error: "No chunks created from document",
      }
    }

    // Prepare documents for ChromaDB
    const chromaDocs = chunkResult.chunks.map((chunk) => ({
      id: chunk.id,
      content: chunk.content,
      metadata: {
        documentId: document.id,
        title: document.title || "",
        source: document.source || "",
        chunkIndex: chunk.index,
        startOffset: chunk.startOffset,
        endOffset: chunk.endOffset,
        ...document.metadata,
      },
    }))

    // Add to collection
    await addDocuments(collection, chromaDocs, config.chromaConfig)

    return {
      documentId: document.id,
      chunksCreated: chunkResult.chunks.length,
      success: true,
    }
  } catch (error) {
    return {
      documentId: document.id,
      chunksCreated: 0,
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

/**
 * Index multiple documents with progress tracking
 */
export async function indexDocuments(
  collectionName: string,
  documents: RAGDocument[],
  config: RAGConfig,
  options?: BatchIndexingOptions
): Promise<IndexingResult[]> {
  const results: IndexingResult[] = []
  const { onProgress, onDocumentComplete, continueOnError = true } = options || {}

  let successCount = 0
  let errorCount = 0

  for (let i = 0; i < documents.length; i++) {
    const doc = documents[i]

    // Report progress
    onProgress?.({
      totalDocuments: documents.length,
      processedDocuments: i,
      currentDocument: doc.id,
      successCount,
      errorCount,
      percentage: Math.round((i / documents.length) * 100),
    })

    const result = await indexDocument(collectionName, doc, config)
    results.push(result)

    if (result.success) {
      successCount++
    } else {
      errorCount++
      if (!continueOnError) {
        break
      }
    }

    onDocumentComplete?.(result)
  }

  // Final progress update
  onProgress?.({
    totalDocuments: documents.length,
    processedDocuments: documents.length,
    successCount,
    errorCount,
    percentage: 100,
  })

  return results
}

/**
 * Index documents in parallel batches for better performance
 */
export async function indexDocumentsBatched(
  collectionName: string,
  documents: RAGDocument[],
  config: RAGConfig,
  options?: BatchIndexingOptions
): Promise<IndexingResult[]> {
  const { batchSize = 10, onProgress, onDocumentComplete, continueOnError = true } = options || {}
  const results: IndexingResult[] = []

  let successCount = 0
  let errorCount = 0

  for (let i = 0; i < documents.length; i += batchSize) {
    const batch = documents.slice(i, i + batchSize)

    // Report progress
    onProgress?.({
      totalDocuments: documents.length,
      processedDocuments: i,
      currentDocument: `batch ${Math.floor(i / batchSize) + 1}`,
      successCount,
      errorCount,
      percentage: Math.round((i / documents.length) * 100),
    })

    // Process batch in parallel
    const batchResults = await Promise.all(
      batch.map((doc) => indexDocument(collectionName, doc, config))
    )

    for (const result of batchResults) {
      results.push(result)
      if (result.success) {
        successCount++
      } else {
        errorCount++
      }
      onDocumentComplete?.(result)
    }

    // Check if we should stop on error
    if (!continueOnError && errorCount > 0) {
      break
    }
  }

  // Final progress update
  onProgress?.({
    totalDocuments: documents.length,
    processedDocuments: documents.length,
    successCount,
    errorCount,
    percentage: 100,
  })

  return results
}

/**
 * Retrieve relevant context for a query
 */
export async function retrieveContext(
  collectionName: string,
  query: string,
  config: RAGConfig
): Promise<RAGContext> {
  const { chromaConfig, topK = 5, similarityThreshold = 0.5, maxContextLength = 4000 } = config

  try {
    const client = getChromaClient(chromaConfig)
    const collection = await getOrCreateCollection(client, collectionName)

    // Query the collection
    const results = await queryCollection(collection, query, chromaConfig, {
      nResults: topK * 2, // Get more results to filter by threshold
    })

    // Filter by similarity threshold
    const filteredResults = results.filter((r) => r.similarity >= similarityThreshold)

    // Take top K
    const topResults = filteredResults.slice(0, topK)

    // Format context
    const formattedContext = formatContext(topResults, maxContextLength)

    // Estimate tokens (rough: 1 token ≈ 4 chars)
    const totalTokensEstimate = Math.ceil(formattedContext.length / 4)

    return {
      documents: topResults,
      query,
      formattedContext,
      totalTokensEstimate,
    }
  } catch (error) {
    log.error("RAG retrieval error", error as Error)
    return {
      documents: [],
      query,
      formattedContext: "",
      totalTokensEstimate: 0,
    }
  }
}

/**
 * Format retrieved documents into context string
 */
function formatContext(documents: SearchResult[], maxLength: number): string {
  if (documents.length === 0) return ""

  const parts: string[] = []
  let currentLength = 0

  for (let i = 0; i < documents.length; i++) {
    const doc = documents[i]
    const header = `[Source ${i + 1}]`
    const source = doc.metadata?.source ? ` (${doc.metadata.source})` : ""
    const title = doc.metadata?.title ? `\nTitle: ${doc.metadata.title}` : ""
    const content = `\n${doc.content}`

    const section = `${header}${source}${title}${content}\n`

    if (currentLength + section.length > maxLength) {
      // Truncate if needed
      const remaining = maxLength - currentLength
      if (remaining > 100) {
        parts.push(section.slice(0, remaining) + "...")
      }
      break
    }

    parts.push(section)
    currentLength += section.length
  }

  return parts.join("\n")
}

/**
 * Generate RAG-enhanced prompt
 */
export function createRAGPrompt(
  userQuery: string,
  context: RAGContext,
  systemPrompt?: string
): string {
  const basePrompt = systemPrompt || "You are a helpful assistant."

  if (!context.formattedContext) {
    return `${basePrompt}\n\nUser: ${userQuery}`
  }

  return `${basePrompt}

Use the following context to answer the user's question. If the context doesn't contain relevant information, say so and provide a general response.

## Context
${context.formattedContext}

## User Question
${userQuery}

## Instructions
- Base your answer on the provided context when relevant
- Cite sources when using information from the context
- If the context doesn't contain the answer, acknowledge this and provide your best response
- Be concise and accurate`
}

/**
 * In-memory RAG for simple use cases (no ChromaDB)
 */
export class SimpleRAG {
  private documents: Map<string, { chunks: DocumentChunk[]; embeddings: number[][] }> = new Map()
  private embeddingConfig: EmbeddingModelConfig
  private apiKey: string

  constructor(embeddingConfig: EmbeddingModelConfig, apiKey: string) {
    this.embeddingConfig = embeddingConfig
    this.apiKey = apiKey
  }

  async addDocument(
    id: string,
    content: string,
    chunkingOptions?: Partial<ChunkingOptions>
  ): Promise<number> {
    const result = chunkDocument(content, chunkingOptions, id)

    if (result.chunks.length === 0) return 0

    const texts = result.chunks.map((c) => c.content)
    const embeddingResult = await generateEmbeddings(texts, this.embeddingConfig, this.apiKey)

    this.documents.set(id, {
      chunks: result.chunks,
      embeddings: embeddingResult.embeddings,
    })

    return result.chunks.length
  }

  async search(
    query: string,
    topK: number = 5
  ): Promise<{ chunk: DocumentChunk; similarity: number }[]> {
    const queryEmbedding = await generateEmbedding(query, this.embeddingConfig, this.apiKey)

    const allChunks: { id: string; embedding: number[]; chunk: DocumentChunk }[] = []

    for (const [_docId, data] of this.documents) {
      for (let i = 0; i < data.chunks.length; i++) {
        allChunks.push({
          id: data.chunks[i].id,
          embedding: data.embeddings[i],
          chunk: data.chunks[i],
        })
      }
    }

    const similar = findMostSimilar(queryEmbedding.embedding, allChunks, topK)

    return similar.map((s) => {
      const found = allChunks.find((c) => c.id === s.id)!
      return {
        chunk: found.chunk,
        similarity: s.similarity,
      }
    })
  }

  getDocumentCount(): number {
    return this.documents.size
  }

  getTotalChunks(): number {
    let total = 0
    for (const data of this.documents.values()) {
      total += data.chunks.length
    }
    return total
  }

  clear(): void {
    this.documents.clear()
  }
}

/**
 * Create a RAG configuration with defaults
 */
export function createRAGConfig(
  apiKey: string,
  embeddingProvider: "openai" | "google" = "openai",
  options?: Partial<RAGConfig>
): RAGConfig {
  const embeddingConfig: EmbeddingModelConfig = {
    provider: embeddingProvider,
    model: embeddingProvider === "openai" ? "text-embedding-3-small" : "text-embedding-004",
  }

  return {
    chromaConfig: {
      mode: "embedded",
      embeddingConfig,
      apiKey,
    },
    chunkingOptions: {
      strategy: "sentence",
      chunkSize: 1000,
      chunkOverlap: 200,
    },
    topK: 5,
    similarityThreshold: 0.5,
    maxContextLength: 4000,
    ...options,
  }
}
