/**
 * Embedding stage of the twin ingest pipeline.
 *
 * Wraps `lib/ai/embedding/embedding.ts:generateEmbeddings` so callers don't
 * have to manage batching / API-key plumbing. Input is the redacted chunk
 * text (PII-free); output is one vector per chunk in input order.
 *
 * The pipeline always feeds *redacted* text to embedders so cloud APIs
 * never see originals. The persist step rebinds the resulting vector to
 * the un-redacted chunk row in Dexie.
 */

import { generateEmbeddings } from "@/lib/ai/embedding/embedding"
import type { ProviderName } from "@/types/provider/provider"

export interface EmbeddingConfig {
  provider: ProviderName
  model: string
  apiKey: string
  baseURL?: string
  /** Maximum chunks per upstream batch. Defaults to 64 (OpenAI cap is 2048
   *  but smaller batches give friendlier rate-limit behaviour). */
  batchSize?: number
}

export interface EmbeddingResult {
  embeddings: number[][]
  /** Approximate cumulative input tokens; bookkept on the parent TwinJob. */
  tokensUsed?: number
}

const DEFAULT_BATCH_SIZE = 64

export async function embedRedactedChunks(
  redactedTexts: string[],
  config: EmbeddingConfig
): Promise<EmbeddingResult> {
  if (redactedTexts.length === 0) return { embeddings: [], tokensUsed: 0 }

  const batchSize = Math.max(1, config.batchSize ?? DEFAULT_BATCH_SIZE)
  const allEmbeddings: number[][] = []
  let tokensUsed = 0

  for (let i = 0; i < redactedTexts.length; i += batchSize) {
    const batch = redactedTexts.slice(i, i + batchSize)
    const result = await generateEmbeddings(batch, {
      provider: config.provider,
      model: config.model,
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    })
    allEmbeddings.push(...result.embeddings)
    if (result.usage?.tokens) tokensUsed += result.usage.tokens
  }

  return { embeddings: allEmbeddings, tokensUsed }
}
