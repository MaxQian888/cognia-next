/**
 * Heuristic prefilter for StyleAgent (M3 quality enhancement).
 *
 * Before sending chunks to the StyleAgent LLM we shrink the candidate
 * pool from "the entire twin's chunk store" down to ~30 chunks that
 * carry the most stylistic signal AND span different sources. The LLM
 * call then picks the final 5-10 samples from this pool. Two effects:
 *
 *   1. **Cost / latency** — 30 short chunks instead of 60 long ones cuts
 *      the prompt by ~50%.
 *   2. **Quality** — MMR (Maximum Marginal Relevance) selection favours
 *      chunks that are both informative AND diverse, so the LLM doesn't
 *      see 10 near-duplicates from the same long doc.
 *
 * Pure: no LLM calls, no DB access — takes the candidate chunks in,
 * returns the trimmed pool. Deterministic given identical input
 * (sorting + tie-breaking are stable).
 */

import type { TwinChunk } from "@/types/twin"

const DEFAULT_TARGET = 30
const MIN_TOKEN_COUNT = 30
/** MMR balance: 1.0 = pure relevance (TF-IDF), 0.0 = pure diversity. */
const MMR_LAMBDA = 0.7

export interface StylePrefilterOptions {
  /** Final pool size after MMR. Defaults to 30. */
  target?: number
  /** Drop chunks below this token count (too short to be stylistic). */
  minTokens?: number
  /** Override the MMR balance — tests + tuning. */
  lambda?: number
}

/**
 * Pick the top `target` chunks from the input pool. The algorithm:
 *
 *   1. Tokenise + build TF / DF tables across the pool.
 *   2. Score each chunk by sum-of-TF-IDF over its top tokens
 *      ("informativeness").
 *   3. Drop chunks that are too short (length < `minTokens`).
 *   4. Greedy MMR — at each step pick the chunk with the highest
 *      `λ * relevance - (1-λ) * max(similarity to already-picked)`.
 *      Similarity = Jaccard over top-token sets, capped to keep
 *      arithmetic cheap.
 *   5. Among ties, prefer chunks whose `sourceId` is under-represented
 *      so a single long doc can't monopolise the final pool.
 */
export function selectStyleCandidates(
  chunks: TwinChunk[],
  options: StylePrefilterOptions = {}
): TwinChunk[] {
  const target = options.target ?? DEFAULT_TARGET
  const minTokens = options.minTokens ?? MIN_TOKEN_COUNT
  const lambda = options.lambda ?? MMR_LAMBDA
  if (chunks.length <= target) {
    return chunks.filter((c) => c.tokenCount >= minTokens || chunks.length <= target)
  }

  const candidates = chunks.filter((c) => c.tokenCount >= minTokens)
  if (candidates.length <= target) return candidates

  // 1+2 — TF-IDF
  const docTokens: Map<string, string[]> = new Map()
  const df: Map<string, number> = new Map()
  for (const chunk of candidates) {
    const tokens = tokenize(chunk.contentRedacted)
    docTokens.set(chunk.id, tokens)
    const seen = new Set(tokens)
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1)
  }
  const N = candidates.length
  const relevance: Map<string, number> = new Map()
  const topTokenSet: Map<string, Set<string>> = new Map()
  for (const chunk of candidates) {
    const tokens = docTokens.get(chunk.id) ?? []
    const tf: Map<string, number> = new Map()
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
    let score = 0
    const tokenScores: Array<[string, number]> = []
    for (const [token, count] of tf) {
      const idf = Math.log((N + 1) / ((df.get(token) ?? 0) + 1)) + 1
      const weight = count * idf
      tokenScores.push([token, weight])
      score += weight
    }
    // Normalise by chunk length so a 5kb chunk doesn't always win.
    relevance.set(chunk.id, score / Math.max(1, tokens.length))
    tokenScores.sort((a, b) => b[1] - a[1])
    topTokenSet.set(chunk.id, new Set(tokenScores.slice(0, 20).map(([t]) => t)))
  }

  // 4 — Greedy MMR with source-balancing tie-breaker.
  const selected: TwinChunk[] = []
  const remaining = new Set(candidates.map((c) => c.id))
  const sourceCounts: Map<string, number> = new Map()
  while (selected.length < target && remaining.size > 0) {
    let best: { id: string; score: number } | null = null
    for (const id of remaining) {
      const rel = relevance.get(id) ?? 0
      let maxSim = 0
      const tokensA = topTokenSet.get(id)!
      for (const picked of selected) {
        const tokensB = topTokenSet.get(picked.id)!
        const sim = jaccard(tokensA, tokensB)
        if (sim > maxSim) maxSim = sim
      }
      const chunk = candidates.find((c) => c.id === id)!
      const sourcePenalty = (sourceCounts.get(chunk.sourceId) ?? 0) * 0.05
      const score = lambda * rel - (1 - lambda) * maxSim - sourcePenalty
      if (!best || score > best.score) best = { id, score }
    }
    if (!best) break
    const picked = candidates.find((c) => c.id === best.id)!
    selected.push(picked)
    remaining.delete(best.id)
    sourceCounts.set(picked.sourceId, (sourceCounts.get(picked.sourceId) ?? 0) + 1)
  }
  return selected
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter += 1
  const union = a.size + b.size - inter
  return inter / union
}

/** Minimal multilingual stopword set. Keeps memory + tokenization cheap. */
const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "if",
  "for",
  "of",
  "to",
  "in",
  "on",
  "at",
  "by",
  "with",
  "from",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "this",
  "that",
  "these",
  "those",
  "as",
  "it",
  "its",
  "we",
  "you",
  "they",
  "i",
  "me",
  "my",
  "your",
  "their",
  "his",
  "her",
  "our",
  "us",
  "them",
  "do",
  "did",
  "does",
  "have",
  "has",
  "had",
  "will",
  "would",
  "should",
  "can",
  "could",
  "may",
  "might",
  "must",
  "shall",
  "not",
  "no",
  "so",
  "the",
  "yes",
  "ok",
  "okay",
  // Common Chinese function words (heuristic — keeps the filter useful for
  // mixed-language twins without forcing a full segmenter).
  "的",
  "了",
  "和",
  "是",
  "在",
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
  "也",
  "都",
  "不",
  "有",
  "没",
  "就",
  "要",
  "去",
  "来",
  "啊",
])

export const __TESTING__ = { tokenize, jaccard, STOPWORDS, MIN_TOKEN_COUNT, MMR_LAMBDA }
