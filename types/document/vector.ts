/**
 * Vector Database Types
 */

export type EmbeddingProvider = "openai" | "google" | "cohere"

export interface EmbeddingModelConfig {
  provider: EmbeddingProvider
  model: string
  dimensions?: number
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

export type VectorDBMode = "embedded" | "server"

export interface VectorCollection {
  id: string
  name: string
  description?: string
  documentCount: number
  embeddingModel: string
  embeddingProvider: EmbeddingProvider
  createdAt: Date
  updatedAt: Date
}

export interface VectorDBDocument {
  id: string
  collectionId: string
  content: string
  metadata?: Record<string, string | number | boolean>
  chunkIndex?: number
  sourceFile?: string
  createdAt: Date
}

export interface VectorSettings {
  mode: VectorDBMode
  serverUrl: string
  embeddingProvider: EmbeddingProvider
  embeddingModel: string
  chunkSize: number
  chunkOverlap: number
  autoEmbed: boolean
  /** Default collection name for RAG searches when not specified */
  defaultCollectionName?: string
}

export interface VectorDBSearchResult {
  id: string
  content: string
  metadata?: Record<string, string | number | boolean>
  distance: number
  similarity: number
}

export interface ChromaConfig {
  mode: VectorDBMode
  serverUrl?: string
  embeddingConfig: EmbeddingModelConfig
  apiKey: string
}

// VectorDocumentChunk - vector-specific chunk type with embedding
export interface VectorDocumentChunk {
  id: string
  content: string
  metadata?: Record<string, string | number | boolean>
  embedding?: number[]
}
