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
 */

// Embedding utilities
export * from "./embedding"

// ChromaDB client (prefixed exports to avoid conflicts)
export {
  type ChromaMode,
  type ChromaConfig,
  type DocumentChunk,
  type SearchResult as ChromaSearchResult,
  type CollectionInfo as ChromaCollectionInfo,
  getChromaClient,
  resetChromaClient,
  getOrCreateCollection,
  deleteCollection as deleteChromaCollection,
  listCollections as listChromaCollections,
  addDocuments as addChromaDocuments,
  updateDocuments as updateChromaDocuments,
  upsertDocuments as upsertChromaDocuments,
  deleteDocuments as deleteChromaDocuments,
  queryCollection,
  getDocuments as getChromaDocuments,
  getCollectionCount,
  peekCollection,
} from "./chroma-client"

// Pinecone types - defined inline to avoid importing the module which has Node.js dependencies
// For Pinecone client functions, import directly from './pinecone-client' on server-side only
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

// Qdrant client
export {
  type QdrantConfig,
  type QdrantDocument,
  type QdrantSearchResult,
  type QdrantCollectionInfo,
  getQdrantClient,
  resetQdrantClient,
  createQdrantCollection,
  deleteQdrantCollection,
  listQdrantCollections,
  collectionExists as qdrantCollectionExists,
  upsertQdrantDocuments,
  queryQdrant,
  deleteQdrantDocuments,
  deleteQdrantByFilter,
  getQdrantDocuments,
  getQdrantCollectionInfo,
  scrollQdrantCollection,
} from "./qdrant-client"

// Milvus client
export {
  type MilvusConfig,
  type MilvusDocument,
  type MilvusSearchResult,
  type MilvusCollectionInfo,
  type MilvusIndexInfo,
  getMilvusClient,
  resetMilvusClient,
  milvusCollectionExists,
  createMilvusCollection,
  deleteMilvusCollection,
  listMilvusCollections,
  getMilvusCollectionInfo,
  upsertMilvusDocuments,
  insertMilvusDocuments,
  queryMilvus,
  searchMilvusByVector,
  deleteMilvusDocuments,
  deleteMilvusByFilter,
  getMilvusDocuments,
  queryMilvusByFilter,
  countMilvusDocuments,
  createMilvusIndex,
  dropMilvusIndex,
  loadMilvusCollection,
  releaseMilvusCollection,
  flushMilvusCollection,
  getMilvusLoadingProgress,
  compactMilvusCollection,
  createMilvusPartition,
  dropMilvusPartition,
  listMilvusPartitions,
  hybridSearchMilvus,
} from "./milvus-client"

// Weaviate client
export {
  type WeaviateConfig,
  type WeaviateDocument,
  type WeaviateSearchResult,
  type WeaviateClassInfo,
  listWeaviateClasses,
  getWeaviateClassInfo,
  createWeaviateClass,
  deleteWeaviateClass,
  upsertWeaviateDocuments,
  deleteWeaviateDocuments,
  getWeaviateDocuments,
  queryWeaviate,
  countWeaviateDocuments,
  scrollWeaviateDocuments,
} from "./weaviate-client"

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
