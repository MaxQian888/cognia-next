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

import { generateEmbedding } from "@/lib/ai/embedding/embedding"
import { getTwinChunksByVectorDocIds } from "@/lib/db/twin-chunks"
import { getTwinProfile } from "@/lib/db/twin-profile"
import { getTwinSource } from "@/lib/db/twin-sources"
import type { Character } from "@/lib/claude/types"
import type { IVectorStore } from "@/lib/vector/store"
import type { TwinChunk, TwinSource, TwinSettings, VectorBackend } from "@/types/twin"
import { DEFAULT_TWIN_SETTINGS } from "@/types/twin"
import { getPluginEventHooks } from "@/lib/plugin"
import { vectorCollectionName } from "../ingest/persist"
import { applySystemPromptTemplate, type AppliedTemplate } from "./system-prompt-template"
import { selectFewShotSamples } from "./few-shot-selector"
import { rerank, type RerankCandidate, type RerankerOptions } from "./reranker"

export interface TwinRuntimeEmbeddingConfig {
  provider: "openai" | "google" | "cohere" | "mistral" | "transformersjs"
  model: string
  apiKey: string
  baseURL?: string
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
export interface ApplyTwinContextRetrievedChunk {
  chunk: { vectorDocId: string; content: string; sourceId: string }
  score: number
  sourceTitle?: string
}

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
}

function settingsFor(character: Character): TwinSettings {
  return {
    enableRag: character.twinSettings?.enableRag ?? DEFAULT_TWIN_SETTINGS.enableRag,
    ragTopK: character.twinSettings?.ragTopK ?? DEFAULT_TWIN_SETTINGS.ragTopK,
    enableStyleFewShot:
      character.twinSettings?.enableStyleFewShot ?? DEFAULT_TWIN_SETTINGS.enableStyleFewShot,
    styleSamplesK: character.twinSettings?.styleSamplesK ?? DEFAULT_TWIN_SETTINGS.styleSamplesK,
  }
}

async function loadSourceTitle(
  sourceId: string,
  cache: Map<string, TwinSource>
): Promise<string | undefined> {
  if (cache.has(sourceId)) return cache.get(sourceId)?.title
  const row = await getTwinSource(sourceId)
  if (row) cache.set(sourceId, row)
  return row?.title
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
    return { applied: null, degraded: false, retrievedChunks: [] }
  }

  const settings = settingsFor(character)
  const profile = await getTwinProfile(character.twinId)
  const collection = deps.vectorCollection ?? vectorCollectionName(character.twinId)

  let queryEmbedding: number[] | null = input.precomputedQueryEmbedding ?? null
  let degraded = false
  let degradedReason: string | undefined

  // Embed the user message — needed by both the RAG and style passes.
  if (!queryEmbedding && (settings.enableRag || settings.enableStyleFewShot)) {
    try {
      const result = await generateEmbedding(userMessage, deps.embedding)
      queryEmbedding = result.embedding
    } catch (err) {
      degraded = true
      degradedReason =
        err instanceof Error ? `embed-failed: ${err.message}` : "embed-failed: unknown"
    }
  }

  // RAG retrieval — only attempt when we have an embedding to search by.
  let retrievedChunks: ApplyTwinContextResult["applied"] extends infer A
    ? A extends { metadata: { retrievedChunkIds: string[] } }
      ? Parameters<typeof applySystemPromptTemplate>[0]["retrievedChunks"]
      : never
    : never = []
  if (settings.enableRag && queryEmbedding && deps.store.searchByEmbedding) {
    try {
      // Over-fetch when a reranker is configured so we have a wider pool to
      // re-score; default fetch size is the user-configured topK.
      const overFetch = deps.reranker?.overFetch ?? 3
      const fetchLimit = deps.reranker
        ? Math.max(settings.ragTopK * overFetch, settings.ragTopK)
        : settings.ragTopK

      const hits = await deps.store.searchByEmbedding(collection, queryEmbedding, {
        limit: fetchLimit,
      })
      const docIds = hits.map((h) => h.id)
      const dbChunks = await getTwinChunksByVectorDocIds(docIds)
      const chunkById = new Map<string, TwinChunk>(dbChunks.map((c) => [c.vectorDocId, c]))
      const sourceTitleCache = new Map<string, TwinSource>()
      const enriched: typeof retrievedChunks = []
      for (const hit of hits) {
        const chunk = chunkById.get(hit.id)
        if (!chunk) continue
        const sourceTitle = await loadSourceTitle(chunk.sourceId, sourceTitleCache)
        enriched.push({ chunk, score: hit.score, sourceTitle })
      }

      // Optional rerank pass — never throws (falls back to identity on
      // scorer / timeout failures).
      if (deps.reranker && enriched.length > settings.ragTopK) {
        const candidates: RerankCandidate[] = enriched.map((rc) => ({
          id: rc.chunk.vectorDocId,
          content: rc.chunk.content,
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
    } catch (err) {
      degraded = true
      degradedReason =
        err instanceof Error ? `retrieve-failed: ${err.message}` : "retrieve-failed: unknown"
    }
  }

  // Style few-shot — pure in-memory pass over the profile. When every
  // StyleSample on the profile has an `embedding` (distill backfilled
  // them during the last run), pass them to the selector for cosine
  // ranking. Otherwise the selector falls back to a token-overlap
  // heuristic on `summary`.
  const styleSamples =
    settings.enableStyleFewShot && profile && queryEmbedding
      ? selectFewShotSamples({
          queryEmbedding,
          samples: profile.styleSamples,
          sampleEmbeddings: profile.styleSamples.every(
            (s) => Array.isArray(s.embedding) && s.embedding.length > 0
          )
            ? profile.styleSamples.map((s) => s.embedding as number[])
            : undefined,
          topK: settings.styleSamplesK,
        }).map((s) => s.sample)
      : []

  const applied = applySystemPromptTemplate({
    baseSystemPrompt: character.systemPrompt,
    twinName: character.name || character.twinId,
    voiceSummary: profile?.voiceSummary,
    entities: profile?.entities ?? [],
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
        content: rc.chunk.content,
        score: rc.score,
      }))
    )
  }

  return {
    applied,
    degraded,
    degradedReason,
    retrievedChunks: retrievedChunks.map((rc) => ({
      chunk: {
        vectorDocId: rc.chunk.vectorDocId,
        content: rc.chunk.content,
        sourceId: rc.chunk.sourceId,
      },
      score: rc.score,
      sourceTitle: rc.sourceTitle,
    })),
  }
}
