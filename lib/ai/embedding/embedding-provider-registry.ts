// Re-export shim: canonical source moved to @cognia/provider-embedding (Stage 3).
export {
  __resetEmbeddingProvidersForTesting,
  getEmbeddingProvider,
  listEmbeddingProviders,
  registerEmbeddingProvider,
  unregisterEmbeddingProvider,
  unregisterProvidersByPlugin,
} from "@cognia/provider-embedding/embedding-provider-registry"
export type { EmbeddingProvider } from "@cognia/provider-embedding/embedding-provider-registry"
