/**
 * Embeddings and chunking.
 *
 * Cognia's barrel also re-exports `compression.ts` (an LLM-driven chat-history
 * compactor). cognia-next does not yet host the chat-runtime contract that
 * compactor depends on (`ExtendedUIMessage`, plugin pre-compact dispatch),
 * so the file was removed from this port. Re-add the re-export when a
 * cognia-next compactor lands.
 */

// Main embedding module (provider-aware embeddings)
export * from "./embedding"

// Embedding utilities - only export non-conflicting items
// The core functions (embed, embedMany, cosineSimilarity) come from embedding.ts
export {
  embedBatch,
  findSimilar,
  calculateSimilarityMatrix,
  clusterBySimilarity,
  normalizeEmbedding,
  euclideanDistance,
  dotProduct,
  averageEmbeddings,
  createInMemoryEmbeddingCache,
  EMBEDDING_MODELS,
  type BatchEmbedOptions,
  type SimilarityResult,
} from "./embedding-utils"

export * from "./chunking"
// compression.ts intentionally not re-exported here (see header comment).
export * from "./sparse-embedding"
export * from "./late-interaction"
export * from "./multimodal-embedding"
export * from "./quantization"
