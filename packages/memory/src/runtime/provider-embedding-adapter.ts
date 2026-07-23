import { generateEmbedding, type EmbeddingConfig } from "@cognia/provider-embedding/embedding"
import { hasNoLeakingPii, redactText } from "@cognia/redact"

export type MemoryEmbedder = (text: string) => Promise<number[]>

export class MemoryEmbeddingPiiError extends Error {
  constructor() {
    super("memory embedding query still contains PII after redaction")
    this.name = "MemoryEmbeddingPiiError"
  }
}

/**
 * Adapt the canonical provider embedding configuration to the small injected
 * function consumed by the framework-agnostic memory retriever.
 */
export function createProviderEmbeddingAdapter(config: EmbeddingConfig): MemoryEmbedder {
  return async (text) => {
    const safeText = redactText(text).redacted
    if (!hasNoLeakingPii(safeText)) throw new MemoryEmbeddingPiiError()
    const result = await generateEmbedding(safeText, config)
    return result.embedding
  }
}
