/**
 * Twin-RAG reranker (Phase 2).
 *
 * Background:
 *   Phase-1 RAG returns the top-K cosine matches from the vector store
 *   directly. Phase-2 introduces an optional reranker stage that takes a
 *   wider candidate pool (`topK * overFetch`), re-scores it against the
 *   user query with a richer signal, and keeps the top-K post-rerank.
 *
 * The default implementation here is the **identity reranker** — it returns
 * the candidates in their original order. Real implementations (e.g. a
 * Cohere / BGE / cross-encoder model) can be wired in by passing a custom
 * `model` argument; the runtime falls back to the identity reranker when
 * `model === undefined` or `model === "identity"`.
 *
 * Pure module — no I/O, no React, no IndexedDB. The Twin Settings UI
 * decides whether to call it; this file is only the algorithm.
 */

export interface RerankCandidate {
  /** Stable id from the vector store. */
  id: string
  /** Text content to score against the query. */
  content: string
  /** Initial similarity score from the cosine search. */
  score: number
  /** Optional source title (for tie-breaking). */
  sourceTitle?: string
}

export interface RerankerOptions {
  /** Model identifier; `"identity"` (or omitted) keeps the original order. */
  model?: "identity" | "bge-reranker-v2" | "cohere-rerank-3" | (string & {})
  /** Final number of candidates to keep after rerank. */
  topK: number
  /**
   * When supplied, the runtime delegates the rerank decision to this scorer.
   * Used by tests to inject deterministic ordering; production paths set
   * this from a Cohere / BGE client based on `model`.
   */
  scorer?: (query: string, candidate: RerankCandidate) => number | Promise<number>
  /**
   * Soft guard — if the scorer takes longer than this many ms across all
   * candidates, the runtime aborts the rerank and falls back to identity
   * order. Default 1500 ms.
   */
  timeoutMs?: number
}

export interface RerankResult {
  candidates: RerankCandidate[]
  /** True when the rerank ran successfully end-to-end. */
  reranked: boolean
  /** Reason for falling back, if any. */
  fallbackReason?: string
}

const DEFAULT_TIMEOUT_MS = 1500

function identityRerank(candidates: readonly RerankCandidate[], topK: number): RerankResult {
  return {
    candidates: candidates.slice(0, Math.max(0, topK)),
    reranked: false,
    fallbackReason: "identity",
  }
}

/**
 * Rerank `candidates` against `query`. Returns a new array — never mutates
 * the input. Always resolves (no throws); failures degrade to the identity
 * order with `reranked: false` and a `fallbackReason`.
 */
export async function rerank(
  query: string,
  candidates: readonly RerankCandidate[],
  options: RerankerOptions
): Promise<RerankResult> {
  const topK = Math.max(0, options.topK)
  if (candidates.length === 0 || topK === 0) {
    return { candidates: [], reranked: false, fallbackReason: "empty-input" }
  }

  const model = options.model ?? "identity"
  const scorer = options.scorer
  if (model === "identity" || !scorer) {
    return identityRerank(candidates, topK)
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  // Race the whole batch against a wall-clock timer so a hung scorer (e.g.
  // network outage to a remote reranker) cannot block the chat send.
  let scores: number[]
  try {
    scores = await Promise.race([
      Promise.all(
        candidates.map(async (cand) => {
          const score = await scorer(query, cand)
          if (typeof score !== "number" || !Number.isFinite(score)) {
            throw new Error("rerank scorer returned non-finite value")
          }
          return score
        })
      ),
      new Promise<number[]>((_resolve, reject) => {
        setTimeout(() => reject(new Error("rerank timeout")), timeoutMs)
      }),
    ])
  } catch (err) {
    const reason = err instanceof Error ? err.message : "rerank failed"
    return {
      candidates: identityRerank(candidates, topK).candidates,
      reranked: false,
      fallbackReason: reason,
    }
  }

  const ranked = candidates
    .map((c, i) => ({ candidate: c, score: scores[i] }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((entry) => ({ ...entry.candidate, score: entry.score }))

  return { candidates: ranked, reranked: true }
}

/**
 * Convenience: produce a stable identity scorer that returns the original
 * cosine score. Useful for tests that want to assert "no reordering".
 */
export function identityScorer(_query: string, c: RerankCandidate): number {
  return c.score
}
