// Re-export shim: canonical source moved to @cognia/provider-embedding (Stage 3).
export {
  RAG_EMBEDDING_PROVIDERS,
  embeddingProviderRequiresApiKey,
  embeddingProviderRequiresBaseURL,
  expectedEmbeddingDimension,
  getEmbeddingProviderDescriptor,
  isRagEmbeddingProvider,
} from "@cognia/provider-embedding/embedding-catalog"
export type {
  EmbeddingProviderDescriptor,
  EmbeddingProviderKind,
  RagEmbeddingProvider,
} from "@cognia/provider-embedding/embedding-catalog"
