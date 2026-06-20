// Re-export shim: canonical source moved to @cognia/provider-embedding (Stage 3).
export {
  VOYAGE_EMBEDDING_BASE_URL,
  aiCosineSimilarity,
  averageEmbeddings,
  cosineSimilarity,
  createEmbeddingCache,
  defaultEmbeddingModels,
  embeddingDimensions,
  euclideanDistance,
  findMostSimilar,
  generateEmbedding,
  generateEmbeddings,
  generateEmbeddingsBatched,
  getEmbeddingDimension,
  normalizeEmbedding,
} from "@cognia/provider-embedding/embedding"
export type {
  BatchEmbeddingResult,
  CohereInputType,
  EmbeddingCache,
  EmbeddingConfig,
  EmbeddingProviderName,
  EmbeddingProviderOptions,
  EmbeddingResult,
} from "@cognia/provider-embedding/embedding"
