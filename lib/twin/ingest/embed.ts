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

import type { RagEmbeddingProvider } from "@cognia/provider-embedding/embedding-catalog"
import { createEmbeddingCache } from "@cognia/rag/embedding-cache"
import { generateEmbeddings } from "@cognia/vector/embedding"
import type { BedrockConnectionSettings } from "@cognia/provider-types"
import { throwIfTwinJobInterrupted } from "@/lib/twin/job-control"

export interface EmbeddingConfig {
  provider: RagEmbeddingProvider
  model: string
  apiKey: string
  baseURL?: string
  bedrock?: BedrockConnectionSettings
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

/**
 * Module-local LRU embedding cache. Reuses the shared RAG toolkit's
 * `EmbeddingCache` but keeps its OWN instance rather than the global singleton:
 * the cache keys by content hash only, so sharing one cache across embedding
 * models (which produce different vectors — and dimensions — for the same text)
 * could hand back a wrong-dimension vector. We scope every key by
 * `provider::model` to keep hits correct across models.
 */
const embeddingCache = createEmbeddingCache({ maxEntries: 5000 })

function cacheKey(config: EmbeddingConfig, text: string): string {
  return `${config.provider}::${config.model}::${text}`
}

export async function embedRedactedChunks(
  redactedTexts: string[],
  config: EmbeddingConfig,
  signal?: AbortSignal
): Promise<EmbeddingResult> {
  throwIfTwinJobInterrupted(signal)
  if (redactedTexts.length === 0) return { embeddings: [], tokensUsed: 0 }

  const batchSize = Math.max(1, config.batchSize ?? DEFAULT_BATCH_SIZE)

  // 1. Resolve cache hits and collect the DISTINCT cache-miss texts to embed.
  //    Identical texts within this call are embedded once (intra-call dedup),
  //    and texts cached from an earlier run (e.g. re-import of the same source)
  //    are skipped entirely — no upstream call, no token spend.
  const resolved = new Map<string, number[]>() // text -> vector
  const toEmbed: string[] = [] // distinct miss texts, first-seen order
  const pending = new Set<string>()
  for (const text of redactedTexts) {
    if (resolved.has(text) || pending.has(text)) continue
    const cached = embeddingCache.get(cacheKey(config, text))
    if (cached) {
      resolved.set(text, cached)
    } else {
      pending.add(text)
      toEmbed.push(text)
    }
  }

  // 2. Embed the cache-miss texts in batches; populate cache + resolved map.
  let tokensUsed = 0
  for (let i = 0; i < toEmbed.length; i += batchSize) {
    throwIfTwinJobInterrupted(signal)
    const batch = toEmbed.slice(i, i + batchSize)
    const result = await generateEmbeddings(
      batch,
      {
        provider: config.provider,
        model: config.model,
        baseURL: config.baseURL,
        bedrock: config.bedrock,
      },
      config.apiKey
    )
    throwIfTwinJobInterrupted(signal)
    // Guard against a provider returning fewer vectors than inputs: without this
    // `result.embeddings[j]` is `undefined`, which would be cached and persisted
    // as a broken vector (and upserted to the remote store). Fail the source
    // instead — the per-source try/catch in the job runner isolates it.
    if (result.embeddings.length !== batch.length) {
      throw new Error(
        `embedRedactedChunks: provider returned ${result.embeddings.length} vectors ` +
          `for a batch of ${batch.length} — refusing to persist undefined embeddings.`
      )
    }
    for (let j = 0; j < batch.length; j++) {
      const vector = result.embeddings[j]
      resolved.set(batch[j], vector)
      embeddingCache.set(cacheKey(config, batch[j]), vector)
    }
    if (result.usage?.tokens) tokensUsed += result.usage.tokens
  }

  // 3. Reassemble exactly one vector per input, in original order.
  const embeddings = redactedTexts.map((text) => resolved.get(text) as number[])
  return { embeddings, tokensUsed }
}

/** Test hook — clears the module-local embedding cache between cases. */
export function __resetTwinEmbeddingCache(): void {
  embeddingCache.clear()
}
