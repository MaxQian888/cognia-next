import {
  createRetrievalProfile,
  createSafeEmbeddingGateway,
  type EmbeddingPurpose,
  type RetrievalVectorBackend,
  type SafeEmbeddingResult,
} from "@cognia/rag"
import { generateEmbedding, type EmbeddingConfig } from "@cognia/provider-embedding/embedding"
import type { RagEmbeddingProvider } from "@cognia/provider-embedding/embedding-catalog"
import { hasNoLeakingPii, redactText } from "@cognia/redact"

export interface GenerateSafeEmbeddingOptions {
  profileId: string
  purpose: EmbeddingPurpose
  embedding: Omit<EmbeddingConfig, "provider"> & { provider: RagEmbeddingProvider }
  vectorBackend: RetrievalVectorBackend
  allowLocalOriginalText?: boolean
  /** Existing provider/vector adapter; receives only gateway-approved text. */
  transport?: (safeText: string) => Promise<number[]>
}

/**
 * Application-owned embedding boundary. Provider transport stays reusable and
 * receives only the gateway-approved projection; no raw text enters its cache.
 */
export async function generateSafeEmbedding(
  text: string,
  options: GenerateSafeEmbeddingOptions
): Promise<SafeEmbeddingResult> {
  const profile = createRetrievalProfile({
    id: options.profileId,
    embedding: {
      provider: options.embedding.provider,
      model: options.embedding.model ?? "default",
      dimensions: options.embedding.dimensions,
    },
    vector: { backend: options.vectorBackend, collectionPolicy: "generation" },
    safety: {
      cloudText: "redact-fail-closed",
      localOriginalText: options.allowLocalOriginalText ? "allow" : "redact",
      retrievedContent: "data-only",
    },
  })
  const gateway = createSafeEmbeddingGateway({
    redact: redactText,
    isSafe: hasNoLeakingPii,
    embed: async (safeText) =>
      options.transport
        ? options.transport(safeText)
        : (await generateEmbedding(safeText, options.embedding)).embedding,
  })
  return gateway.embed({ profile, purpose: options.purpose, text })
}
