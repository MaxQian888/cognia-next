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

import type { Memory, MemoryType } from "@/types/memory/memory"
import { BM25Index, normalizeScores, reciprocalRankFusion } from "@cognia/rag/hybrid-search"
import { scoreMemories } from "./scoring"

export interface MemoryRetrieverDeps {
  /** Active candidate pool for the reader (global + character override layer). */
  loadCandidates: (characterId?: string) => Promise<Memory[]>
  /** Embed the query; absent → BM25-only. */
  embed?: (text: string) => Promise<number[]>
  /** Vector search returning `{ id: vectorDocId, score }`; absent → BM25-only. */
  vectorSearch?: (embedding: number[], topK: number) => Promise<{ id: string; score: number }[]>
  /** Mark hits accessed (recency). Optional; failures are swallowed by the caller. */
  touch?: (memoryIds: string[]) => Promise<void>
}

export interface RetrieveMemoriesInput {
  queryText: string
  characterId?: string
  topK: number
  /** Drop candidates whose normalized fused relevance is below this. */
  relevanceFloor: number
  /** Restrict to these types (e.g. semantic+episodic for injection). */
  types?: MemoryType[]
}

export interface RetrievedMemory {
  memory: Memory
  /** Normalized fused relevance in [0,1]. */
  relevance: number
  /** Combined three-factor score. */
  score: number
}

const OVERFETCH = 4

export async function retrieveMemories(
  input: RetrieveMemoriesInput,
  deps: MemoryRetrieverDeps
): Promise<RetrievedMemory[]> {
  const query = input.queryText.trim()
  if (!query) return []

  let candidates = await deps.loadCandidates(input.characterId)
  if (input.types) {
    const allow = new Set(input.types)
    candidates = candidates.filter((m) => allow.has(m.type))
  }
  if (candidates.length === 0) return []

  const byId = new Map(candidates.map((m) => [m.id, m]))
  const byVectorDocId = new Map<string, Memory>()
  for (const m of candidates) {
    if (m.vectorDocId) byVectorDocId.set(m.vectorDocId, m)
  }

  // Keyword leg — always available.
  const bm25 = new BM25Index()
  bm25.addDocuments(candidates.map((m) => ({ id: m.id, content: m.text })))
  const keywordHits = bm25.search(query, input.topK * OVERFETCH)

  // Vector leg — best effort; any failure degrades to BM25-only.
  let vectorHits: { id: string; score: number }[] = []
  if (deps.embed && deps.vectorSearch) {
    try {
      const embedding = await deps.embed(query)
      const raw = await deps.vectorSearch(embedding, input.topK * OVERFETCH)
      vectorHits = raw
        .map((h) => {
          const m = byVectorDocId.get(h.id)
          return m ? { id: m.id, score: h.score } : null
        })
        .filter((h): h is { id: string; score: number } => h !== null)
    } catch {
      vectorHits = []
    }
  }

  // Fuse (or pass through the single leg), then normalize to [0,1] for the floor.
  const fused =
    vectorHits.length > 0
      ? reciprocalRankFusion([vectorHits, keywordHits])
      : keywordHits.map((h) => ({ id: h.id, score: h.score }))
  if (fused.length === 0) return []

  const normalized = normalizeScores(fused)
  const relevanceById = new Map(normalized.map((n) => [n.id, n.score]))

  const floored = normalized.filter((n) => n.score >= input.relevanceFloor)
  if (floored.length === 0) return []

  const scorable = floored
    .map((n) => byId.get(n.id))
    .filter((m): m is Memory => m !== undefined)
    .map((m) => ({ ...m, relevance: relevanceById.get(m.id) ?? 0 }))

  const ranked = scoreMemories(scorable, {}).slice(0, input.topK)

  const result: RetrievedMemory[] = ranked.map((r) => ({
    memory: byId.get(r.memory.id)!,
    relevance: relevanceById.get(r.memory.id) ?? 0,
    score: r.score,
  }))

  if (deps.touch && result.length > 0) {
    try {
      await deps.touch(result.map((r) => r.memory.id))
    } catch {
      // Touch is best-effort; a failure must not break retrieval.
    }
  }

  return result
}
