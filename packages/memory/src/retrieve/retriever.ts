/**
 * Memory retrieval — thin orchestration over the shared RAG toolkit. Reuses
 * `BM25Index` + `reciprocalRankFusion` + `normalizeScores` (`lib/ai/rag/
 * hybrid-search.ts`) and the three-factor `scoreMemories` (`./scoring`). No new
 * keyword/fusion math here.
 *
 * Dependency-injected (no direct DB / vector / embedding imports) so it unit-
 * tests without a live backend. The read runtime (`apply-memory-context`) wires
 * the real `lib/db/memories`, `IVectorStore`, and `generateEmbedding`.
 *
 * Degradation: when `embed`/`vectorSearch` are absent (no embedding provider or
 * cloud embedding disabled) it runs BM25-only — same "best effort" contract as
 * the Twin runtime.
 */

import {
  DEFAULT_MEMORY_CONFIG,
  isProjectClaim,
  type Memory,
  type MemoryReaderContext,
  type MemoryType,
} from "../types/memory"
import { BM25Index, normalizeScores, reciprocalRankFusion } from "@cognia/rag/hybrid-search"
import { tokenizeMultilingual } from "@cognia/rag/cjk-tokenizer"
import { sha256Hex } from "@cognia/rag/retrieval-profile"
import type { RetrievalDegradeReason, RetrievalTraceV1 } from "@cognia/rag/retrieval-kernel"
import {
  memoryCorpusId,
  memoryRetrievalDegraded,
  type MemoryRetrievalOutcome,
} from "../control-plane/retrieval-telemetry"
import { buildExpandedKeywordQuery } from "./query-expansion"
import {
  governanceScoreFor,
  recencyHalfLifeDaysForType,
  scoreMemories,
  veracityFor,
} from "./scoring"

/**
 * Terms too common to signal topical relevance. The BM25 leg returns *any* doc
 * sharing ≥1 term (the tokenizer has no stopword list), and `normalizeScores`
 * then promotes a lone weak hit to relevance 1.0 — so without a stopword gate a
 * memory that overlaps the query only on "the" / "用户" gets force-injected
 * nearly every turn. Covers EN function words + the most common CJK particles
 * (the multilingual tokenizer emits one token per CJK character, so single
 * particles dominate spurious overlaps).
 */
const STOPWORDS = new Set<string>([
  // English function words
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "if",
  "then",
  "else",
  "of",
  "to",
  "in",
  "on",
  "at",
  "for",
  "from",
  "by",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "am",
  "do",
  "does",
  "did",
  "has",
  "have",
  "had",
  "i",
  "you",
  "he",
  "she",
  "it",
  "we",
  "they",
  "me",
  "him",
  "her",
  "them",
  "my",
  "your",
  "his",
  "its",
  "our",
  "their",
  "this",
  "that",
  "these",
  "those",
  "there",
  "here",
  "with",
  "as",
  "so",
  "not",
  "no",
  "yes",
  "ok",
  "what",
  "when",
  "where",
  "who",
  "why",
  "how",
  "which",
  "will",
  "would",
  "can",
  "could",
  "should",
  "about",
  // Common CJK function words / particles (tokenized per-character)
  "的",
  "了",
  "和",
  "是",
  "我",
  "你",
  "他",
  "她",
  "它",
  "我们",
  "你们",
  "他们",
  "这",
  "那",
  "在",
  "有",
  "就",
  "也",
  "都",
  "与",
  "及",
  "对",
  "把",
  "被",
  "着",
  "过",
  "吗",
  "呢",
  "吧",
  "啊",
  "会",
  "要",
  "让",
  "给",
  "但",
  "而",
  "或",
  "等",
  "个",
  "之",
  "其",
  "上",
  "下",
])

/** Distinct non-stopword tokens in `text` (case handled by the tokenizer). */
export function meaningfulTerms(text: string): Set<string> {
  const out = new Set<string>()
  for (const term of tokenizeMultilingual(text)) {
    if (term.length === 0 || STOPWORDS.has(term)) continue
    out.add(term)
  }
  return out
}

export interface MemoryRetrieverDeps {
  /** Active candidate pool for the reader (global + character override layer). */
  loadCandidates: (reader?: MemoryReaderContext | string) => Promise<Memory[]>
  /** Embed the query; absent → BM25-only. */
  embed?: (text: string) => Promise<number[]>
  /** Vector search returning `{ id: vectorDocId, score }`; absent → BM25-only. */
  vectorSearch?: (embedding: number[], topK: number) => Promise<{ id: string; score: number }[]>
  /** Mark hits accessed (recency). Optional; failures are swallowed by the caller. */
  touch?: (memoryIds: string[]) => Promise<void>
  /**
   * The shared rollout kill switch. Same name and shape as
   * `RetrievalKernelDependencies.killSwitchEngaged`, because it is the same
   * concept rather than a new one.
   *
   * Evaluated per call, so a mid-session flip takes effect on the next recall.
   * This lives HERE rather than in the dep builder because the builder runs once
   * per turn and is reused across team members, and because switching off the
   * vector leg by withholding `vectorSearch` would make the kill switch
   * indistinguishable from having no backend at all.
   */
  killSwitchEngaged?: () => boolean | Promise<boolean>
  /** Control-plane identity and sink for the trace this recall produces. */
  telemetry?: MemoryRetrievalTelemetry
}

export interface MemoryRetrievalTelemetry {
  profileFingerprint: string
  generationId: string
  /** Persist the trace. Fire-and-forget; a trace must never affect the hits. */
  record?: (trace: RetrievalTraceV1, corpusId: string) => void | Promise<void>
  now?: () => number
  createTraceId?: () => string
}

export interface RetrieveMemoriesInput {
  queryText: string
  characterId?: string
  /** Full namespace-aware reader context; supersedes `characterId` when present. */
  reader?: MemoryReaderContext
  topK: number
  /** Drop candidates whose normalized fused relevance is below this. */
  relevanceFloor: number
  /** Restrict to these types (e.g. semantic+episodic for injection). */
  types?: MemoryType[]
  /**
   * Which corpus to search. Absent searches BOTH, which is only correct for
   * callers that genuinely want everything (the console, similarity lookups
   * during consolidation).
   *
   * Every prompt-injecting caller MUST pass one. Personal memory and mined
   * project claims are rendered under different headings with different voices —
   * one says the user told you this, the other says the workspace was observed
   * doing this — so a row reaching the wrong section is a correctness bug, not a
   * ranking nit.
   *
   * Partitioning here rather than after retrieval is deliberate, for two reasons
   * that both bite. `normalizeScores` is min-max over the FUSED set, so ranking
   * the corpora together and splitting afterwards lets eight strong claims
   * normalize a decent personal fact toward zero and under `relevanceFloor` —
   * the two sections would compete invisibly and the loser would be silent. And
   * `topK` is per call, so a post-filter can only offer "K mixed, then split",
   * which can return K claims and zero personal facts.
   */
  claimFilter?: "personal-only" | "project-only"
  /**
   * Query embedding computed once by the caller for this turn. When provided,
   * the vector leg reuses it instead of calling `deps.embed(query)` — avoids a
   * redundant embed on paths that already embedded the same query for twin RAG
   * (and, per team turn, avoids re-embedding once per member).
   */
  precomputedQueryEmbedding?: number[]
  /**
   * Heuristic synonym expansion of the BM25 keyword leg only (the vector leg
   * keeps the raw query). Off by default — opt-in via `MemoryConfig`. Lifts
   * recall for alternate phrasings without changing the semantic ranking.
   */
  enableQueryExpansion?: boolean
  /**
   * Base recency half-life (days) from `MemoryConfig.decayHalfLifeDays`. Scaled
   * per memory type (episodic fades fast, procedural lingers) into the recency
   * factor. Defaults to `DEFAULT_MEMORY_CONFIG.decayHalfLifeDays` when omitted.
   */
  recencyHalfLifeDays?: number
  /** Stable clock for expiry and score tests. */
  now?: number
}

export interface RetrievedMemory {
  memory: Memory
  /** Normalized fused relevance in [0,1]. */
  relevance: number
  /** Combined three-factor score. */
  score: number
}

const OVERFETCH = 4

// Signature-cached BM25 index over the candidate corpus. Mirrors the twin
// runtime's per-twin cache (`lib/twin/runtime/bm25-index.ts`): rebuild only when
// the corpus changes (cheap `{count}:{latestUpdatedAt}` signal), so we tokenise
// once per corpus change instead of on every retrieval — and, in a team turn,
// once instead of per member. `updatedAt` is used (not `lastAccessedAt`, which
// `touch()` bumps every turn and would defeat the cache).
// TODO(retrieval): fold this + the twin cache into a shared
// `lib/ai/retrieval/` helper when the two hybrid pipelines are unified.
interface CachedMemoryBm25 {
  index: BM25Index
  signature: string
}
const memoryBm25Cache = new Map<string, CachedMemoryBm25>()
// Two entries per reader, not one: a turn that recalls personal memory AND
// project claims builds two indexes under two cache keys. Left at 4 this evicts
// on every turn and the cache degrades into a re-tokenize loop — worst in a team
// turn, whose members already compete for slots.
const MAX_CACHED_CORPORA = 8

function corpusSignature(candidates: Memory[]): string {
  let latest = 0
  for (const m of candidates) if (m.updatedAt > latest) latest = m.updatedAt
  return `${candidates.length}:${latest}`
}

function getMemoryBm25Index(cacheKey: string, candidates: Memory[]): BM25Index {
  const signature = corpusSignature(candidates)
  const cached = memoryBm25Cache.get(cacheKey)
  if (cached && cached.signature === signature) {
    // Refresh LRU recency (most-recently-used moves to the end).
    memoryBm25Cache.delete(cacheKey)
    memoryBm25Cache.set(cacheKey, cached)
    return cached.index
  }
  const index = new BM25Index()
  index.addDocuments(candidates.map((m) => ({ id: m.id, content: m.text })))
  memoryBm25Cache.set(cacheKey, { index, signature })
  while (memoryBm25Cache.size > MAX_CACHED_CORPORA) {
    const oldest = memoryBm25Cache.keys().next().value
    if (oldest === undefined) break
    memoryBm25Cache.delete(oldest)
  }
  return index
}

/** Test hook — drop cached indexes so cases don't leak corpus state. */
export function __resetMemoryBm25Cache(): void {
  memoryBm25Cache.clear()
}

export function isMemoryEligibleForRetrieval(memory: Memory, now: number = Date.now()): boolean {
  if (memory.status !== "active") return false
  if (memory.expiresAt !== null && memory.expiresAt !== undefined && memory.expiresAt <= now) {
    return false
  }
  if (memory.staleness === "expired" || memory.trustState === "quarantined") return false
  if (memory.reviewStatus === "conflict") return false
  if (memory.type === "procedural" && memory.reviewStatus !== "verified") return false
  return true
}

/**
 * Compatibility wrapper. Seven call sites read the plain array, and four test
 * factories mock this shape, so the richer return is opt-in.
 */
export async function retrieveMemories(
  input: RetrieveMemoriesInput,
  deps: MemoryRetrieverDeps
): Promise<RetrievedMemory[]> {
  return (await retrieveMemoriesWithOutcome(input, deps)).hits
}

export async function retrieveMemoriesWithOutcome(
  input: RetrieveMemoriesInput,
  deps: MemoryRetrieverDeps
): Promise<MemoryRetrievalOutcome> {
  const now = deps.telemetry?.now ?? Date.now
  const startedAt = now()
  const reasons: RetrievalDegradeReason[] = []
  const exclusions: { id: string; reason: string }[] = []
  let cacheHit = false

  const finish = async (
    hits: RetrievedMemory[],
    candidateIds: string[],
    scores: RetrievalTraceV1["scores"],
    queryText: string
  ): Promise<MemoryRetrievalOutcome> => {
    const trace: RetrievalTraceV1 = {
      schemaVersion: 1,
      traceId: deps.telemetry?.createTraceId?.() ?? crypto.randomUUID(),
      // The query never appears, only its hash. Everything else is ids, counts
      // and numbers, which is what makes this safe to persist.
      //
      // Only hashed when telemetry is configured. Without it nothing reads the
      // field, and a SubtleCrypto digest on the return path of every recall
      // (including the early exits that found nothing) is pure cost.
      queryHash: queryText && deps.telemetry ? await sha256Hex(queryText) : "",
      profileFingerprint: deps.telemetry?.profileFingerprint ?? "",
      generationId: deps.telemetry?.generationId ?? "",
      candidateIds,
      hitIds: hits.map((hit) => hit.memory.id),
      scores,
      exclusions,
      cacheHit,
      budget: { topK: input.topK, tokenLimit: 0, tokensUsed: 0 },
      latencyMs: Math.max(0, now() - startedAt),
    }
    if (deps.telemetry?.record && queryText) {
      // NOT awaited. `record` is wired to an IndexedDB write, and awaiting it
      // put a control-plane round trip on the chat send path: a slow or
      // contended write extended the turn, which is the exact coupling this
      // dependency is documented not to have. Both a synchronous throw and a
      // rejected promise are swallowed.
      try {
        void Promise.resolve(
          deps.telemetry.record(
            trace,
            memoryCorpusId({
              ...(input.claimFilter ? { claimFilter: input.claimFilter } : {}),
              ...(input.reader?.projectId ? { projectId: input.reader.projectId } : {}),
            })
          )
        ).catch(() => undefined)
      } catch {
        // A control-plane write must never change what a turn recalls.
      }
    }
    return { hits, degraded: memoryRetrievalDegraded(reasons), reasons, trace }
  }

  const query = input.queryText.trim()
  if (!query) return finish([], [], [], "")

  const reader = input.reader ?? input.characterId

  // Project claims are scoped to a workspace by construction, so asking for them
  // without one can only ever return nothing. Bail before touching the corpus —
  // belt and braces on top of `isVisibleToReader`, which already refuses to hand
  // a row carrying a `projectId` to a reader in a different (or no) project.
  if (input.claimFilter === "project-only" && !input.reader?.projectId) {
    return finish([], [], [], query)
  }

  let candidates = (await deps.loadCandidates(reader)).filter((memory) =>
    isMemoryEligibleForRetrieval(memory, input.now)
  )
  if (input.types) {
    const allow = new Set(input.types)
    candidates = candidates.filter((m) => allow.has(m.type))
  }
  if (input.claimFilter) {
    // `isProjectClaim` is the ONE place "absent means personal" is expressed, so
    // this filter and the console's facet can never disagree about which corpus
    // a row belongs to. Applied before the BM25 index is built, so each corpus
    // gets its own index and its own score normalization.
    const wantProject = input.claimFilter === "project-only"
    candidates = candidates.filter((m) => isProjectClaim(m) === wantProject)
  }
  if (candidates.length === 0) return finish([], [], [], query)

  const byId = new Map(candidates.map((m) => [m.id, m]))
  const byVectorDocId = new Map<string, Memory>()
  for (const m of candidates) {
    if (m.vectorDocId) byVectorDocId.set(m.vectorDocId, m)
  }

  // Keyword leg — always available. Index is cached by corpus signature so an
  // unchanged candidate set (same reader + type filter) isn't re-tokenised.
  const cacheKey = `${JSON.stringify(input.reader ?? { characterId: input.characterId })}::${(
    input.types ?? []
  )
    .slice()
    .sort()
    .join(",")}::${input.claimFilter ?? "all"}`
  cacheHit = memoryBm25Cache.get(cacheKey)?.signature === corpusSignature(candidates)
  const bm25 = getMemoryBm25Index(cacheKey, candidates)
  const keywordQuery = input.enableQueryExpansion ? buildExpandedKeywordQuery(query) : query
  const rawKeywordHits = bm25.search(keywordQuery, input.topK * OVERFETCH)

  // Stopword gate: drop keyword hits that overlap the query only on stopwords.
  // BM25 returns any doc sharing a single term, and the min-max normalization
  // below would promote such a lone weak hit to relevance 1.0 — injecting an
  // off-topic memory on a shared "the" / "用户". Require ≥1 shared MEANINGFUL
  // term. Skipped for a degenerate all-stopword query (keep prior behavior).
  const queryTerms = meaningfulTerms(query)
  const keywordHits =
    queryTerms.size === 0
      ? rawKeywordHits
      : rawKeywordHits.filter((h) => {
          const m = byId.get(h.id)
          if (!m) return false
          const terms = meaningfulTerms(m.text)
          for (const t of queryTerms) if (terms.has(t)) return true
          return false
        })

  // Vector leg. Best effort, but no longer SILENT: a failure here used to be
  // caught, emptied, and reported as an ordinary BM25 result, so "the backend
  // is down" and "the corpus has nothing" looked identical from outside.
  let vectorHits: { id: string; score: number }[] = []
  const killSwitch = await resolveKillSwitch(deps)
  if (killSwitch) {
    // BM25 keeps running. `KILL_SWITCH_ALLOWED` in the control plane permits
    // `lexical_read` precisely so a stopped rollout still answers from the
    // keyword index rather than silently returning nothing.
    reasons.push({ code: "kill_switch_active", stage: "vector", retryable: false })
  } else if (!deps.vectorSearch || !(input.precomputedQueryEmbedding || deps.embed)) {
    reasons.push({ code: "vector_not_configured", stage: "vector", retryable: false })
  } else {
    let embedding: number[] | undefined
    try {
      embedding = input.precomputedQueryEmbedding ?? (await deps.embed!(query))
    } catch {
      reasons.push({ code: "embedding_unavailable", stage: "query", retryable: true })
    }
    if (embedding && embedding.length === 0) {
      reasons.push({ code: "vector_dimension_mismatch", stage: "vector", retryable: false })
      embedding = undefined
    }
    if (embedding) {
      try {
        const raw = await deps.vectorSearch(embedding, input.topK * OVERFETCH)
        vectorHits = raw
          .map((h) => {
            const m = byVectorDocId.get(h.id)
            return m ? { id: m.id, score: h.score } : null
          })
          .filter((h): h is { id: string; score: number } => h !== null)
      } catch {
        vectorHits = []
        reasons.push({ code: "vector_unavailable", stage: "vector", retryable: true })
      }
    }
  }

  // Fuse (or pass through the single leg), then normalize to [0,1] for the floor.
  const fused =
    vectorHits.length > 0
      ? reciprocalRankFusion([vectorHits, keywordHits])
      : keywordHits.map((h) => ({ id: h.id, score: h.score }))
  const candidateIds = fused.map((f) => f.id)
  const scoreTrace = (): RetrievalTraceV1["scores"] =>
    fused.map(({ id, score }) => ({
      id,
      lexical: keywordHits.find((hit) => hit.id === id)?.score,
      vector: vectorHits.find((hit) => hit.id === id)?.score,
      fused: score,
    }))
  if (fused.length === 0) return finish([], candidateIds, scoreTrace(), query)

  const normalized = normalizeScores(fused)
  const relevanceById = new Map(normalized.map((n) => [n.id, n.score]))

  const floored = normalized.filter((n) => n.score >= input.relevanceFloor)
  for (const below of normalized.filter((n) => n.score < input.relevanceFloor)) {
    exclusions.push({ id: below.id, reason: "below_floor" })
  }
  if (floored.length === 0) return finish([], candidateIds, scoreTrace(), query)

  // Per-type recency decay + source-trust (veracity) weighting: a fresh, user-
  // stated fact outranks a stale, inbound one of equal relevance. `veracityFor`
  // is a ranking signal only — the provenance injection gate stays in the reader.
  const baseHalfLife = input.recencyHalfLifeDays ?? DEFAULT_MEMORY_CONFIG.decayHalfLifeDays
  const scorable = floored
    .map((n) => byId.get(n.id))
    .filter((m): m is Memory => m !== undefined)
    .map((m) => ({
      ...m,
      relevance: relevanceById.get(m.id) ?? 0,
      halfLifeDays: recencyHalfLifeDaysForType(m.type, baseHalfLife),
      veracity: veracityFor(m),
      governance: governanceScoreFor(m),
    }))

  const ranked = scoreMemories(scorable, { now: input.now }).slice(0, input.topK)

  const result: RetrievedMemory[] = ranked.map((r) => ({
    memory: byId.get(r.memory.id)!,
    relevance: relevanceById.get(r.memory.id) ?? 0,
    score: r.score,
  }))

  const selected = new Set(result.map((r) => r.memory.id))
  for (const row of floored) {
    if (!selected.has(row.id)) exclusions.push({ id: row.id, reason: "over_topk" })
  }

  if (deps.touch && result.length > 0) {
    try {
      await deps.touch(result.map((r) => r.memory.id))
    } catch {
      // Touch is best-effort; a failure must not break retrieval.
    }
  }

  return finish(result, candidateIds, scoreTrace(), query)
}

/** Fail closed: an unanswerable kill switch is treated as engaged. */
async function resolveKillSwitch(deps: MemoryRetrieverDeps): Promise<boolean> {
  if (!deps.killSwitchEngaged) return false
  try {
    return await deps.killSwitchEngaged()
  } catch {
    return true
  }
}
