// Re-export shim: canonical source moved to @cognia/provider-core (Stage 2).
export {
  DEFAULT_OLLAMA_URL,
  copyOllamaModel,
  deleteOllamaModel,
  generateOllamaEmbedding,
  getOllamaModelCapabilities,
  getOllamaStatus,
  isOllamaEmbeddingModel,
  listOllamaModels,
  listRunningModels,
  pullOllamaModel,
  showOllamaModel,
  stopOllamaModel,
} from "@cognia/provider-core/providers/ollama"
