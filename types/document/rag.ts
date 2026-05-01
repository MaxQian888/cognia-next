/**
 * RAG (Retrieval Augmented Generation) Types
 */

export type ChunkingStrategy = "fixed" | "sentence" | "paragraph" | "semantic"

export interface ChunkingOptions {
  strategy: ChunkingStrategy
  chunkSize: number
  chunkOverlap: number
  minChunkSize?: number
  maxChunkSize?: number
}

import type { DocumentChunk } from "./document"

export interface ChunkingResult {
  chunks: DocumentChunk[]
  totalChunks: number
  originalLength: number
  strategy: ChunkingStrategy
}

export interface RAGDocument {
  id: string
  content: string
  title?: string
  source?: string
  metadata?: Record<string, string | number | boolean>
}

export interface RAGContext {
  documents: RAGSearchResult[]
  query: string
  formattedContext: string
  totalTokensEstimate: number
}

export interface RAGSearchResult {
  id: string
  content: string
  metadata?: Record<string, string | number | boolean>
  distance: number
  similarity: number
}

export interface IndexingResult {
  documentId: string
  chunksCreated: number
  success: boolean
  error?: string
}

export interface RAGConfig {
  collectionName: string
  topK: number
  similarityThreshold: number
  maxContextLength: number
  chunkingOptions: ChunkingOptions
}
