/**
 * Runtime entry point — given a twin-bound `Character` and the latest user
 * message, retrieve RAG context + style few-shot and assemble the final
 * `SendOptions.systemPrompt`. Designed to be called from the chat-send
 * pipeline (`lib/claude/build-options.ts`) right before the message is
 * dispatched.
 *
 * The function is structured so the heavy lifting (vector search, Dexie
 * lookups) is isolated from the prompt assembly. Every external
 * dependency is injected via `ApplyTwinContextDeps` so unit tests can run
 * without spinning up a vector store, embedding API, or IndexedDB.
 */

import type { RagEmbeddingProvider } from "@cognia/provider-embedding/embedding-catalog"
import type { BedrockConnectionSettings } from "@cognia/provider-types"
import { generateSafeEmbedding } from "@/lib/rag/safe-embedding"
import { generateEmbedding as generateVectorEmbedding } from "@cognia/vector/embedding"
import {
  ensureCollectionDimensionCompatible,
  EmbeddingDimensionMismatchError,
} from "@cognia/vector/dimension-guard"
import { getTwinChunksByVectorDocIds } from "@/lib/db/twin-chunks"
import { backfillStyleSampleEmbeddings, getTwinProfile } from "@/lib/db/twin-profile"
import { getTwinSourcesByIds } from "@/lib/db/twin-sources"
import type { Character } from "@cognia/agent-config-types"
import type { IVectorStore } from "@cognia/vector/store"
import type {
  RetrievedTwinChunk,
  StyleSample,
  TwinChunk,
  TwinSource,
  TwinSettings,
  VectorBackend,
} from "@/types/twin"
import { DEFAULT_TWIN_SETTINGS } from "@/types/twin"
import { getPluginEventHooks } from "@/lib/plugin/messaging/hooks-system"
import { vectorCollectionName } from "../ingest/persist"
import { reciprocalRankFusion } from "@cognia/rag/hybrid-search"
import { generateHypotheticalAnswer, generateStepBackQuery } from "@cognia/rag/query-expansion"
import { formatCitations, type Citation } from "@cognia/rag/citation-formatter"
import { applySystemPromptTemplate, type AppliedTemplate } from "./system-prompt-template"
import { selectFewShotSamples } from "./few-shot-selector"
import { keywordSearch } from "./bm25-index"
import { rerank, type RerankCandidate, type RerankerOptions } from "./reranker"
import { buildExpandedKeywordQuery } from "@/lib/ai/retrieval/query-expansion"
import { filterByGrade } from "@/lib/ai/retrieval/corrective-filter"
import { hasNoLeakingPii } from "@cognia/redact"
import type { LanguageModel } from "ai"

export interface TwinRuntimeEmbeddingConfig {
  provider: RagEmbeddingProvider
  model: string
  apiKey: string
  baseURL?: string
  bedrock?: BedrockConnectionSettings
}

function embed(text: string, config: TwinRuntimeEmbeddingConfig, vectorBackend: VectorBackend) {
  return generateSafeEmbedding(text, {
    profileId: "twin",
    purpose: "query",
    embedding: config,
    vectorBackend,
    transport: async (safeText) =>
      (await generateVectorEmbedding(safeText, config, config.apiKey)).embedding,
  })
}

export interface ApplyTwinContextDeps {
  /** The remote vector store the twin's chunks live in. */
  store: IVectorStore
  /** Embedding config used to vectorise the user's query. */
  embedding: TwinRuntimeEmbeddingConfig
  /** Vector backend label persisted on chunks (defaults to store.provider). */
  vectorBackend?: VectorBackend
  /** Override the collection name. Defaults to `cognia_twin_{twinId}`. */
  vectorCollection?: string
  /**
   * Optional reranker config. When omitted, no rerank pass runs and the
   * cosine top-K is used as-is. When supplied, the runtime fetches
   * `topK * overFetch` candidates, hands them to `rerank`, and keeps the
   * top-K of the reranker's output.
   */
  reranker?: Omit<RerankerOptions, "topK"> & {
    /** Multiplier applied to topK before fetching candidates. Default 3. */
    overFetch?: number
  }
  /**
   * Optional LLM query-expansion (HyDE / step-back). When set AND the character
   * opts in via `enableQueryExpansion`, the runtime generates an expanded query
   * with this model, embeds it, runs a second vector search, and RRF-fuses the
   * two vector rankings. Heuristic synonym expansion of the BM25 leg needs no
   * dep — this only carries the LLM handle + strategy.
   */
  expansion?: { model: LanguageModel; strategy: "hyde" | "stepback" }
}

export interface ApplyTwinContextInput {
  character: Character
  /** The latest user-message text. */
  userMessage: string
  /**
   * Optional pre-embedded query vector. Team chat passes this in once per
   * turn so all twin-bound members share a single embed call. When provided,
   * the runtime skips `generateEmbedding(userMessage)`.
   */
  precomputedQueryEmbedding?: number[]
  /**
   * Optional session id for the chat that triggered the lookup. Used only
   * by the plugin-event hook (`onRAGContextRetrieved`) to scope dispatched
   * sources. When omitted, the runtime falls back to `twin:<twinId>`.
   */
  sessionId?: string
  deps: ApplyTwinContextDeps
}

/**
 * Retrieved-chunk envelope surfaced to the chat UI so it can emit a Twin-RAG
 * SourcesPart alongside the assistant message. Mirrors the internal shape
 * used by `applySystemPromptTemplate`.
 */
export type ApplyTwinContextRetrievedChunk = RetrievedTwinChunk

export interface ApplyTwinContextResult {
  /** The applied template + metadata. `null` when the character is not
   *  twin-bound and no work was done. */
  applied: AppliedTemplate | null
  /** True when the runtime degraded to a no-context path (embedding or
   *  vector store unreachable). The caller surfaces this in the UI so
   *  users know their answer didn't include retrieved material. */
  degraded: boolean
  /** Reason for degradation, if any. */
  degradedReason?: string
  /**
   * RAG chunks used to build the system prompt. Empty when RAG is disabled
   * or the retrieval pass degraded. Exposed for the chat layer so it can
   * emit a Twin-RAG SourcesPart alongside the assistant message.
   */
  retrievedChunks: ApplyTwinContextRetrievedChunk[]
  /**
   * Style samples actually selected by `selectFewShotSamples` for this turn.
   * Empty when style few-shot is disabled, the profile has no samples, or
   * the embedding pass degraded. The chat layer surfaces these alongside
   * `retrievedChunks` so the user can see what shaped the reply.
   */
  selectedStyleSamples: StyleSample[]
  /**
   * Formatted source citations for the retrieved chunks. Present only when the
   * character has `enableCitations` on. Metadata only — never alters the
   * assembled system prompt (so the model's output is unaffected).
   */
  citations?: Citation[]
}

function settingsFor(character: Character): TwinSettings {
  const s = character.twinSettings
  return {
    enableRag: s?.enableRag ?? DEFAULT_TWIN_SETTINGS.enableRag,
    ragTopK: s?.ragTopK ?? DEFAULT_TWIN_SETTINGS.ragTopK,
    enableStyleFewShot: s?.enableStyleFewShot ?? DEFAULT_TWIN_SETTINGS.enableStyleFewShot,
    styleSamplesK: s?.styleSamplesK ?? DEFAULT_TWIN_SETTINGS.styleSamplesK,
    enableHybrid: s?.enableHybrid ?? DEFAULT_TWIN_SETTINGS.enableHybrid,
    hybridKeywordWeight: s?.hybridKeywordWeight ?? DEFAULT_TWIN_SETTINGS.hybridKeywordWeight,
    enableQueryExpansion: s?.enableQueryExpansion ?? DEFAULT_TWIN_SETTINGS.enableQueryExpansion,
    enableCorrectiveFilter:
      s?.enableCorrectiveFilter ?? DEFAULT_TWIN_SETTINGS.enableCorrectiveFilter,
    correctiveMinKeep: s?.correctiveMinKeep ?? DEFAULT_TWIN_SETTINGS.correctiveMinKeep,
    enableCitations: s?.enableCitations ?? DEFAULT_TWIN_SETTINGS.enableCitations,
    citationStyle: s?.citationStyle ?? DEFAULT_TWIN_SETTINGS.citationStyle,
  }
}

// In-flight style-embedding backfills, keyed by twinId. Prevents a burst of
// chat turns from each kicking off a redundant backfill for the same twin.
const styleBackfillInFlight = new Map<string, Promise<unknown>>()

/**
 * Fire-and-forget lazy backfill of `StyleSample.embedding`. The cosine
 * few-shot path only activates once EVERY sample has an embedding; distill
 * embeds new samples inline, but legacy profiles, per-sample embed failures,
 * and manually-added samples leave gaps. When we spot a gap (and the query
 * embedding succeeded, so the provider is reachable), we kick off a backfill
 * in the background: THIS turn still uses the query-aware token-overlap
 * fallback, and subsequent turns pick up the persisted embeddings. Never
 * blocks the send and never throws.
 */
function maybeBackfillStyleEmbeddings(
  twinId: string,
  samples: StyleSample[],
  embedding: TwinRuntimeEmbeddingConfig,
  vectorBackend: VectorBackend
): void {
  const hasGap = samples.some((s) => !(Array.isArray(s.embedding) && s.embedding.length > 0))
  if (!hasGap || styleBackfillInFlight.has(twinId)) return
  const task = backfillStyleSampleEmbeddings(twinId, (summary) =>
    embed(summary, embedding, vectorBackend).then((r) => r.embedding)
  )
    .catch(() => {
      // Swallow — a transient embed/DB failure just means we retry next turn.
    })
    .finally(() => {
      styleBackfillInFlight.delete(twinId)
    })
  styleBackfillInFlight.set(twinId, task)
}

/** Test hook — await any in-flight style-embedding backfills. */
export async function __flushStyleBackfills(): Promise<void> {
  await Promise.all([...styleBackfillInFlight.values()])
}

/**
 * Main entry point. Always returns — never throws — so a runtime hiccup
 * in the twin pipeline cannot break the chat send. Callers should treat
 * `result.applied === null` as "fall back to the character's plain
 * systemPrompt".
 */
export async function applyTwinContext(
  input: ApplyTwinContextInput
): Promise<ApplyTwinContextResult> {
  const { character, userMessage, deps } = input
  if (!character.twinId) {
    return { applied: null, degraded: false, retrievedChunks: [], selectedStyleSamples: [] }
  }

  const settings = settingsFor(character)
  const collection = deps.vectorCollection ?? vectorCollectionName(character.twinId)

  let queryEmbedding: number[] | null = input.precomputedQueryEmbedding ?? null
  let degraded = false
  let degradedReason: string | undefined

  // Load the profile defensively. getTwinProfile is documented as "never
  // throws", but a Dexie failure (db locked / corrupt / quota exceeded) would
  // otherwise propagate straight out of applyTwinContext and break its OWN
  // never-throws contract — which today only survives because every caller
  // re-wraps it. Degrade here instead so the guarantee is real.
  let profile: Awaited<ReturnType<typeof getTwinProfile>>
  try {
    profile = await getTwinProfile(character.twinId)
  } catch (err) {
    profile = undefined
    degraded = true
    degradedReason =
      err instanceof Error ? `profile-load-failed: ${err.message}` : "profile-load-failed: unknown"
  }

  // Embed the user message — needed by both the RAG and style passes.
  if (!queryEmbedding && (settings.enableRag || settings.enableStyleFewShot)) {
    try {
      const result = await embed(userMessage, deps.embedding, deps.vectorBackend ?? "native")
      queryEmbedding = result.embedding
    } catch (err) {
      degraded = true
      degradedReason =
        err instanceof Error ? `embed-failed: ${err.message}` : "embed-failed: unknown"
    }
  }

  // RAG retrieval — only attempt when we have an embedding to search by.
  let retrievedChunks: RetrievedTwinChunk[] = []
  if (settings.enableRag && queryEmbedding && deps.store.searchByEmbedding) {
    try {
      // Over-fetch when a reranker is configured so we have a wider pool to
      // re-score; default fetch size is the user-configured topK.
      const overFetch = deps.reranker?.overFetch ?? 3
      const fetchLimit = deps.reranker
        ? Math.max(settings.ragTopK * overFetch, settings.ragTopK)
        : settings.ragTopK

      // Dimension guard: if the collection was built with a different
      // embedding model than the one now configured, block before searching
      // with a mismatched query vector (cloud backends error / native rejects).
      await ensureCollectionDimensionCompatible(deps.store, collection, queryEmbedding.length, {
        provider: deps.embedding.provider,
        model: deps.embedding.model,
      })

      const vectorHits = await deps.store.searchByEmbedding(collection, queryEmbedding, {
        limit: fetchLimit,
      })

      // Vector ranking fed to the hybrid + rerank stages. Starts as the raw
      // cosine hits; the optional LLM query-expansion leg (HyDE / step-back)
      // fuses a second search over an LLM-generated query for extra recall.
      let vectorRanking = vectorHits.map((h) => ({ id: h.id, score: h.score }))
      if (settings.enableQueryExpansion && deps.expansion) {
        if (hasNoLeakingPii(userMessage)) {
          try {
            const expandedText =
              deps.expansion.strategy === "stepback"
                ? await generateStepBackQuery(userMessage, deps.expansion.model)
                : await generateHypotheticalAnswer(userMessage, deps.expansion.model)
            if (expandedText.trim().length > 0) {
              const expEmbedding = (
                await embed(expandedText, deps.embedding, deps.vectorBackend ?? "native")
              ).embedding
              const expHits = await deps.store.searchByEmbedding(collection, expEmbedding, {
                limit: fetchLimit,
              })
              // Original query dominant (0.6) over the LLM-expanded one (0.4).
              vectorRanking = reciprocalRankFusion(
                [vectorRanking, expHits.map((h) => ({ id: h.id, score: h.score }))],
                [0.6, 0.4],
                60
              )
            }
          } catch (err) {
            degraded = true
            degradedReason =
              err instanceof Error
                ? `expansion-failed: ${err.message}`
                : "expansion-failed: unknown"
          }
        } else {
          // The raw message carries PII — never send it to the expansion LLM.
          degraded = true
          degradedReason = "expansion-pii-skip"
        }
      }

      // Hybrid retrieval: fuse the vector ranking with a BM25 keyword ranking
      // over the same corpus via Reciprocal Rank Fusion. Off by default — when
      // disabled we pass the vector hits through unchanged (and preserve their
      // raw similarity scores). BM25 recall lifts verbatim ids / proper nouns /
      // file references that pure semantic search ranks low.
      let orderedIds: string[] = []
      const scoreById = new Map<string, number>()
      const setVectorOnly = (): void => {
        orderedIds = vectorRanking.map((h) => h.id)
        scoreById.clear()
        for (const h of vectorRanking) scoreById.set(h.id, h.score)
      }
      if (settings.enableHybrid && character.twinId) {
        try {
          // Heuristic synonym expansion widens the BM25 recall leg only.
          const keywordQuery = settings.enableQueryExpansion
            ? buildExpandedKeywordQuery(userMessage)
            : userMessage
          const keywordHits = await keywordSearch(character.twinId, keywordQuery, fetchLimit)
          const keywordWeight = Math.min(1, Math.max(0, settings.hybridKeywordWeight))
          const fused = reciprocalRankFusion(
            [vectorRanking, keywordHits],
            [1 - keywordWeight, keywordWeight],
            60
          )
          orderedIds = fused.slice(0, fetchLimit).map((f) => f.id)
          for (const f of fused) scoreById.set(f.id, f.score)
        } catch (err) {
          // The BM25 lane failed but the vector search already succeeded —
          // fall back to vector-only ordering rather than discarding the good
          // vector hits (which is what letting this reach the outer catch would
          // do, mislabelled as `retrieve-failed`). Flag the partial degradation.
          degraded = true
          degradedReason =
            err instanceof Error
              ? `hybrid-bm25-failed: ${err.message}`
              : "hybrid-bm25-failed: unknown"
          setVectorOnly()
        }
      } else {
        setVectorOnly()
      }

      const dbChunks = await getTwinChunksByVectorDocIds(orderedIds)
      const chunkById = new Map<string, TwinChunk>(dbChunks.map((c) => [c.vectorDocId, c]))
      // Batch-load every distinct source once (single bulkGet) so the per-hit
      // title lookup below is synchronous — no N+1 serial Dexie awaits.
      const sourceIds = Array.from(
        new Set(dbChunks.map((c) => c.sourceId).filter((id): id is string => Boolean(id)))
      )
      const sourceById = new Map<string, TwinSource>(
        (await getTwinSourcesByIds(sourceIds)).map((s) => [s.id, s])
      )
      const enriched: RetrievedTwinChunk[] = []
      for (const id of orderedIds) {
        const chunk = chunkById.get(id)
        if (!chunk) continue
        enriched.push({
          chunk: {
            id: chunk.id,
            vectorDocId: chunk.vectorDocId,
            sourceId: chunk.sourceId,
            contentRedacted: chunk.contentRedacted,
          },
          score: scoreById.get(id) ?? 0,
          sourceTitle: sourceById.get(chunk.sourceId)?.title,
        })
      }

      // Optional rerank pass — never throws (falls back to identity on
      // scorer / timeout failures).
      if (deps.reranker && enriched.length > settings.ragTopK) {
        const candidates: RerankCandidate[] = enriched.map((rc) => ({
          id: rc.chunk.vectorDocId,
          content: rc.chunk.contentRedacted,
          score: rc.score,
          sourceTitle: rc.sourceTitle,
        }))
        const reranked = await rerank(userMessage, candidates, {
          ...deps.reranker,
          topK: settings.ragTopK,
        })
        const byId = new Map(enriched.map((rc) => [rc.chunk.vectorDocId, rc]))
        retrievedChunks = reranked.candidates
          .map((c) => {
            const original = byId.get(c.id)
            if (!original) return null
            return { ...original, score: c.score }
          })
          .filter((x): x is (typeof enriched)[number] => x !== null)
      } else {
        retrievedChunks = enriched.slice(0, settings.ragTopK)
      }

      // Corrective-RAG: drop low-relevance chunks (heuristic, no LLM). Never
      // empties a non-empty pool below correctiveMinKeep, and keeps the pool
      // untouched when it is already weak-but-only.
      if (settings.enableCorrectiveFilter && retrievedChunks.length > 0) {
        const kept = await filterByGrade(
          userMessage,
          retrievedChunks.map((rc) => ({
            id: rc.chunk.vectorDocId,
            content: rc.chunk.contentRedacted,
            score: rc.score,
          })),
          { minKeep: settings.correctiveMinKeep ?? 1 }
        )
        const keptIds = new Set(kept.map((k) => k.id))
        retrievedChunks = retrievedChunks.filter((rc) => keptIds.has(rc.chunk.vectorDocId))
      }
    } catch (err) {
      degraded = true
      if (err instanceof EmbeddingDimensionMismatchError) {
        degradedReason = `dimension-mismatch: ${err.message}`
      } else {
        degradedReason =
          err instanceof Error ? `retrieve-failed: ${err.message}` : "retrieve-failed: unknown"
      }
    }
  } else if (settings.enableRag && queryEmbedding && !deps.store.searchByEmbedding) {
    // RAG was requested and we have a query embedding, but the configured store
    // exposes no `searchByEmbedding` — surface it as a degradation instead of
    // silently returning "no context, no warning".
    degraded = true
    degradedReason = "store-no-search"
  }

  // Style few-shot — pure in-memory pass over the profile. We pass a SPARSE
  // per-sample embedding array (the sample's `embedding` or null): the selector
  // scores each sample by cosine when it has an embedding and falls back to
  // token-overlap only for the gaps. A single un-embedded sample therefore no
  // longer drags the whole profile onto the lossy path. We still kick off a
  // background backfill so the remaining gaps light up cosine on a later turn.
  if (settings.enableStyleFewShot && profile && profile.styleSamples.length > 0 && queryEmbedding) {
    maybeBackfillStyleEmbeddings(
      character.twinId,
      profile.styleSamples,
      deps.embedding,
      deps.vectorBackend ?? "native"
    )
  }
  const styleSamples =
    settings.enableStyleFewShot && profile && queryEmbedding
      ? selectFewShotSamples({
          queryEmbedding,
          samples: profile.styleSamples,
          sampleEmbeddings: profile.styleSamples.map((s) =>
            Array.isArray(s.embedding) && s.embedding.length > 0 ? s.embedding : null
          ),
          queryText: userMessage,
          topK: settings.styleSamplesK,
        }).map((s) => s.sample)
      : []

  const applied = applySystemPromptTemplate({
    baseSystemPrompt: character.systemPrompt,
    twinName: character.name || character.twinId,
    voiceSummary: profile?.voiceSummary,
    entities: profile?.entities ?? [],
    playbooks: profile?.playbooks ?? [],
    decisions: profile?.decisions ?? [],
    retrievedChunks,
    styleSamples,
  })

  // Plugin host: announce the retrieved chunks so plugins observing
  // `onRAGContextRetrieved` can react (e.g. surface citations). Skip when
  // RAG was disabled for this character — empty payloads add noise.
  if (settings.enableRag && retrievedChunks.length > 0) {
    const sessionId = input.sessionId ?? `twin:${character.twinId}`
    getPluginEventHooks().dispatchRAGContextRetrieved(
      sessionId,
      retrievedChunks.map((rc) => ({
        id: rc.chunk.vectorDocId,
        content: rc.chunk.contentRedacted,
        score: rc.score,
      }))
    )
  }

  // Optional citations for the Twin-RAG SourcesPart — metadata only. Built
  // from the SAME final chunk set, so it never diverges from the prompt (which
  // it does not touch: `applySystemPromptTemplate` above is unchanged).
  const citations =
    settings.enableCitations && retrievedChunks.length > 0
      ? formatCitations(
          retrievedChunks.map((rc) => ({
            id: rc.chunk.vectorDocId,
            content: rc.chunk.contentRedacted,
            rerankScore: rc.score,
            metadata: {
              title: rc.sourceTitle,
              source: rc.sourceTitle ?? rc.chunk.sourceId,
            },
          })),
          { style: settings.citationStyle ?? "simple", includeRelevanceScore: true }
        ).citations
      : undefined

  return {
    applied,
    degraded,
    degradedReason,
    retrievedChunks,
    selectedStyleSamples: styleSamples,
    ...(citations ? { citations } : {}),
  }
}
