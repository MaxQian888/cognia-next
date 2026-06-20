// Re-export shim: canonical source moved to @cognia/provider-embedding (Stage 3).
export {
  EMBEDDING_MODELS,
  averageEmbeddings,
  calculateSimilarityMatrix,
  clusterBySimilarity,
  cosineSimilarity,
  createInMemoryEmbeddingCache,
  dotProduct,
  embed,
  embedBatch,
  embedMany,
  euclideanDistance,
  findSimilar,
  normalizeEmbedding,
  reduceEmbeddingDimensions,
} from "@cognia/provider-embedding/embedding-utils"
export type {
  BatchEmbedOptions,
  BatchEmbeddingResult,
  EmbeddingCache,
  EmbeddingResult,
  SimilarityResult,
} from "@cognia/provider-embedding/embedding-utils"
