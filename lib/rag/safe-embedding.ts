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
import { providerNameFromId } from "@cognia/agent-trace"

import { instrumentSpan } from "@/lib/agent-trace/instrument"

export interface GenerateSafeEmbeddingOptions {
  profileId: string
  purpose: EmbeddingPurpose
  embedding: Omit<EmbeddingConfig, "provider"> & { provider: RagEmbeddingProvider }
  vectorBackend: RetrievalVectorBackend
  allowLocalOriginalText?: boolean
  /** Existing provider/vector adapter; receives only gateway-approved text. */
  transport?: (safeText: string) => Promise<number[]>
  /** Session the embedding belongs to, for trace correlation. */
  sessionId?: string
  /** Reuse the caller's trace so the embedding nests under the work that asked for it. */
  traceId?: string
  parentSpanId?: string
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
  // `embeddings` is an OTel GenAI well-known operation, and embedding calls are
  // billed spend that produced no span at all before — an embed-heavy ingest
  // was invisible in both the waterfall and the cost rollups.
  return instrumentSpan(
    {
      operationName: "embeddings",
      providerName: providerNameFromId(options.embedding.provider),
      sessionId: options.sessionId ?? options.profileId,
      surface: "embedding",
      requestModel: options.embedding.model,
      ...(options.traceId ? { traceId: options.traceId } : {}),
      ...(options.parentSpanId ? { parentSpanId: options.parentSpanId } : {}),
      metadata: {
        purpose: options.purpose,
        profileId: options.profileId,
        vectorBackend: options.vectorBackend,
      },
    },
    () => gateway.embed({ profile, purpose: options.purpose, text }),
    // Shape and provenance, never the vector itself: an embedding is derived
    // from user text and has no place in a trace.
    (result) => ({
      metadata: {
        dimensions: result.dimensions,
        locality: result.locality,
        redacted: result.redacted,
        cacheHit: result.cacheHit,
      },
    })
  )
}
