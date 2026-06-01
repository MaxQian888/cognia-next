/**
 * Three-factor memory retrieval scoring (Generative Agents):
 *
 *   score = wRecency·norm(recency) + wImportance·norm(importance) + wRelevance·norm(relevance)
 *
 * with all weights = 1 and each factor min-max normalized across the candidate
 * set. `recency` is an exponential decay (0.995^Δdays) over time-since-last-
 * access; `importance` is the LLM 1–10 rating; `relevance` is the fused hybrid
 * similarity (vector+BM25 via `reciprocalRankFusion`) computed by the retriever.
 *
 * Pure — no I/O, no clock except the injected `now`. The retriever applies the
 * relevance floor on the *raw* fused score before calling this; this module
 * only ranks.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000
const DEFAULT_RECENCY_DECAY = 0.995

export interface ScorableMemory {
  /** LLM-rated 1..10. */
  importance: number
  /** Epoch ms of last access (or creation). */
  lastAccessedAt: number
  /** Fused hybrid similarity in [0,1] (already floored by the caller). */
  relevance: number
}

export interface MemoryScoreParts {
  recency: number
  importance: number
  relevance: number
}

export interface ScoredMemory<T> {
  memory: T
  score: number
  parts: MemoryScoreParts
}

export interface ScoreOptions {
  /** Reference time; defaults to `Date.now()`. */
  now?: number
  /** Per-day decay base in (0,1]; defaults to 0.995. */
  recencyDecay?: number
  /** Factor weights; default all 1. */
  weights?: Partial<MemoryScoreParts>
}

/** Min-max normalize to [0,1]. When all values are equal, returns 1s (neutral). */
function minMaxNormalize(values: number[]): number[] {
  if (values.length === 0) return []
  let min = values[0]
  let max = values[0]
  for (const v of values) {
    if (v < min) min = v
    if (v > max) max = v
  }
  const range = max - min
  if (range === 0) return values.map(() => 1)
  return values.map((v) => (v - min) / range)
}

/** Exponential recency: `decay ^ daysSinceLastAccess`, clamped at age ≥ 0. */
function rawRecency(lastAccessedAt: number, now: number, decay: number): number {
  const ageDays = Math.max(0, (now - lastAccessedAt) / MS_PER_DAY)
  return Math.pow(decay, ageDays)
}

export function scoreMemories<T extends ScorableMemory>(
  memories: T[],
  opts: ScoreOptions = {}
): ScoredMemory<T>[] {
  if (memories.length === 0) return []
  const now = opts.now ?? Date.now()
  const decay = opts.recencyDecay ?? DEFAULT_RECENCY_DECAY
  const wRecency = opts.weights?.recency ?? 1
  const wImportance = opts.weights?.importance ?? 1
  const wRelevance = opts.weights?.relevance ?? 1

  const recencyRaw = memories.map((m) => rawRecency(m.lastAccessedAt, now, decay))
  const importanceRaw = memories.map((m) => Math.min(10, Math.max(1, m.importance)) / 10)
  const relevanceRaw = memories.map((m) => m.relevance)

  const recency = minMaxNormalize(recencyRaw)
  const importance = minMaxNormalize(importanceRaw)
  const relevance = minMaxNormalize(relevanceRaw)

  return memories
    .map((memory, i) => {
      const parts: MemoryScoreParts = {
        recency: recency[i],
        importance: importance[i],
        relevance: relevance[i],
      }
      const score =
        wRecency * parts.recency + wImportance * parts.importance + wRelevance * parts.relevance
      return { memory, score, parts }
    })
    .sort((a, b) => b.score - a.score)
}
