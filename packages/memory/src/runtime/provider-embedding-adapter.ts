import { generateEmbedding, type EmbeddingConfig } from "@cognia/provider-embedding/embedding"

export type MemoryEmbedder = (text: string) => Promise<number[]>

/**
 * Adapt the canonical provider embedding configuration to the small injected
 * function consumed by the framework-agnostic memory retriever.
 */
export function createProviderEmbeddingAdapter(config: EmbeddingConfig): MemoryEmbedder {
  return async (text) => {
    const result = await generateEmbedding(text, config)
    return result.embedding
  }
}
