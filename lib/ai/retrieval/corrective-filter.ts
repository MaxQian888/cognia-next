/**
 * Shared corrective-RAG filter.
 *
 * Wraps the (previously dormant) `@cognia/rag/retrieval-grader` heuristic
 * grader into one adapter the twin runtime uses to drop low-relevance chunks
 * after fusion/rerank. Heuristic-only (no LLM, no network), so it is safe on
 * every send path. Never empties a non-empty pool below `minKeep`, and skips
 * grading entirely when the pool is already weak-but-only (a weak-but-only
 * result set still beats returning no context).
 */

import { gradeRetrievedDocuments, isRetrievalSufficient } from "@cognia/rag/retrieval-grader"
import type { RerankResult } from "@cognia/rag/reranker"

export interface CorrectiveChunk {
  id: string
  content: string
  /** Prior rank score (cosine / RRF / rerank) — feeds the grader's boost term. */
  score?: number
}

/**
 * Return the subset of `chunks` whose ids survive heuristic relevance grading,
 * preserving input order. Falls back to keeping the best `minKeep` when grading
 * would drop too many.
 */
export async function filterByGrade<T extends CorrectiveChunk>(
  query: string,
  chunks: readonly T[],
  opts: { minKeep?: number } = {}
): Promise<T[]> {
  if (chunks.length === 0) return []
  const minKeep = Math.max(1, opts.minKeep ?? 1)

  const docs: RerankResult[] = chunks.map((c) => ({
    id: c.id,
    content: c.content,
    rerankScore: c.score ?? 0,
  }))

  // If nothing clears even a minimal relevance bar, keep the pool untouched
  // rather than dropping everything.
  if (!isRetrievalSufficient(query, docs, { minRelevant: minKeep })) {
    return [...chunks]
  }

  const graded = await gradeRetrievedDocuments(query, docs, {
    useLLM: false,
    fallbackStrategy: "keep_best",
    minChunks: minKeep,
    maxChunksToGrade: docs.length,
  })
  const keep = new Set(graded.relevantDocuments.map((d) => d.id))
  return chunks.filter((c) => keep.has(c.id))
}
