/**
 * Minimal in-memory vector utilities for semantic dedup + similarity ranking.
 * No vector DB — the loop only ever holds a few hundred queries/URLs, so plain
 * cosine over arrays is enough (matches the Jina DeepSearch design note).
 * Re-implemented locally to keep the plugin free of `@/lib/*` imports.
 */

/** Cosine similarity in [-1, 1]. Returns 0 for empty/mismatched/zero vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/**
 * Keep the first occurrence of each near-duplicate. `embeddings[i]` is the
 * vector for `items[i]`. An item is dropped when its cosine similarity to any
 * already-kept item is >= `threshold`.
 */
export function dedupeByEmbedding<T>(items: T[], embeddings: number[][], threshold = 0.92): T[] {
  const kept: T[] = []
  const keptVecs: number[][] = []
  for (let i = 0; i < items.length; i++) {
    const vec = embeddings[i] ?? []
    const isDup = keptVecs.some((kv) => cosineSimilarity(vec, kv) >= threshold)
    if (!isDup) {
      kept.push(items[i])
      keptVecs.push(vec)
    }
  }
  return kept
}

/**
 * Rank candidates by cosine similarity to `query`, descending. Filters by
 * `threshold` and truncates to `topK`.
 */
export function findMostSimilar(
  query: number[],
  candidates: { id: string; embedding: number[] }[],
  options: { topK?: number; threshold?: number } = {}
): { id: string; score: number }[] {
  const { topK = 5, threshold = 0 } = options
  return candidates
    .map((c) => ({ id: c.id, score: cosineSimilarity(query, c.embedding) }))
    .filter((r) => r.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
}
