// Re-export shim: canonical source moved to @cognia/provider-embedding (Stage 3).
export {
  DEFAULT_LOCAL_EMBEDDING_MODEL,
  OPENAI_COMPATIBLE_EMBEDDING_PROVIDERS,
  isOpenAICompatibleEmbeddingProvider,
  resolveLocalEmbeddingBaseURL,
} from "@cognia/provider-embedding/local-embedding"
export type { OpenAICompatibleEmbeddingProvider } from "@cognia/provider-embedding/local-embedding"
