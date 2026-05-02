/**
 * Vector module exports
 *
 * Supported Embedding Providers:
 * - OpenAI (text-embedding-3-small, text-embedding-3-large)
 * - Google (text-embedding-004)
 * - Cohere (embed-english-v3.0, embed-multilingual-v3.0)
 * - Mistral (mistral-embed)
 *
 * Supported Vector Databases:
 * - ChromaDB (embedded and server modes)
 * - Pinecone (serverless)
 * - Qdrant (local and cloud)
 * - Milvus (self-hosted and Zilliz Cloud)
 * - Weaviate (self-hosted and cloud)
 * - Native (Tauri-local sqlite-vec)
 */

// Embedding utilities
export * from "./embedding"

// Pinecone types are inlined here because @/lib/vector/pinecone-client uses
// Node-only APIs and cannot be imported from browser bundles. Server code
// should import the client directly from "./pinecone-client".
export interface PineconeConfig {
  apiKey: string
  indexName: string
  namespace?: string
}

export interface PineconeDocument {
  id: string
  content: string
  metadata?: Record<string, string | number | boolean | string[]>
  embedding?: number[]
}

export interface PineconeSearchResult {
  id: string
  content: string
  metadata?: Record<string, string | number | boolean | string[]>
  score: number
}

export interface PineconeIndexInfo {
  name: string
  dimension: number
  metric: string
  host: string
  status: {
    ready: boolean
    state: string
  }
}

// Unified vector store interface
export {
  type VectorStoreProvider,
  type VectorDocument,
  type VectorSearchResult,
  type VectorStoreConfig,
  type VectorCollectionInfo,
  type SearchOptions,
  type SearchResponse,
  type ScrollOptions,
  type ScrollResponse,
  type VectorStats,
  type FilterOperation,
  type PayloadFilter,
  type CollectionExport,
  type CollectionImport,
  type IVectorStore,
  NativeVectorStore,
  ChromaVectorStore,
  PineconeVectorStore,
  QdrantVectorStore,
  MilvusVectorStore,
  WeaviateVectorStore,
  createVectorStore,
  getSupportedVectorStoreProviders,
} from "./store"

export { verifyVectorBackendReadiness } from "./readiness"
