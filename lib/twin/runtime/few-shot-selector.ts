/**
 * Few-shot selector for runtime style retrieval.
 *
 * The runtime takes the user's query, embeds it once, and uses the same
 * vector to (a) retrieve top-K knowledge chunks from the remote vector
 * store, and (b) score every `StyleSample` in the profile against that
 * query. The latter is in-memory (profiles cap at a few hundred samples
 * before workbench-side trimming kicks in) so we keep it cheap and
 * dependency-free.
 *
 * Crucially, the selector takes the QUERY embedding as input — the
 * caller is responsible for pre-computing it, so the runtime only pays
 * for one `embed()` call regardless of how many subsystems consume it.
 */

import type { StyleSample } from "@/types/twin"

export interface ScoredStyleSample {
  sample: StyleSample
  score: number
}

export interface FewShotSelectorInput {
  /** Pre-computed embedding of the user's query (cosine-similarity space). */
  queryEmbedding: number[]
  /** All style samples on the profile. */
  samples: StyleSample[]
  /**
   * Optional per-sample embeddings of each sample's `summary`, index-aligned
   * with `samples`. Individual entries may be `null`/`undefined` for samples
   * not yet embedded (the runtime backfills lazily). Such samples fall back to
   * token-overlap *individually* — a single un-embedded sample no longer forces
   * the whole profile onto the lossy path.
   */
  sampleEmbeddings?: Array<number[] | null | undefined>
  /**
   * Raw user-query text. Used ONLY by the no-embeddings fallback to rank
   * samples by lexical token-overlap against their `summary`. The runtime
   * always passes this so the fallback is query-aware; when omitted, the
   * selector degrades to a length heuristic.
   */
  queryText?: string
  /** Top-K to return. Defaults to 3 (matches `DEFAULT_TWIN_SETTINGS`). */
  topK?: number
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * Score every sample by cosine vs the query and return the top-K.
 *
 * **Fallback behaviour:** when `sampleEmbeddings` is omitted (eg. the
 * profile hasn't been re-embedded since the latest StyleAgent run), the
 * selector falls back to a token-overlap heuristic on `summary`. The
 * heuristic is lossy but lets the workbench show *something* before the
 * embedder backfill finishes.
 */
export function selectFewShotSamples(input: FewShotSelectorInput): ScoredStyleSample[] {
  const k = Math.max(1, input.topK ?? 3)
  if (input.samples.length === 0) return []

  const queryText = input.queryText?.trim() ?? ""
  const embeddings = input.sampleEmbeddings

  // Score per-sample: cosine when this sample has an embedding, token-overlap
  // (or a length heuristic when there's no query text) otherwise. Doing this
  // per-index — rather than all-or-nothing — means a single un-embedded sample
  // (e.g. one whose embed call threw during backfill) can't force the entire
  // profile onto the lossy fallback. Cosine ([-1,1]) and overlap ([0,1]) aren't
  // on identical scales, but mixing only happens transiently until the lazy
  // backfill fills the gaps, and it's strictly better than disabling cosine.
  const scored: ScoredStyleSample[] = input.samples.map((sample, i) => {
    const emb = embeddings?.[i]
    if (emb && emb.length > 0) {
      return { sample, score: cosineSimilarity(input.queryEmbedding, emb) }
    }
    const score =
      queryText.length === 0
        ? 1 / (1 + Math.abs(sample.summary.length - 50))
        : tokenOverlap(queryText, sample.summary)
    return { sample, score }
  })

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, k)
}

function tokenOverlap(a: string, b: string): number {
  const ta = new Set(a.toLowerCase().split(/\W+/).filter(Boolean))
  const tb = new Set(b.toLowerCase().split(/\W+/).filter(Boolean))
  if (ta.size === 0 || tb.size === 0) return 0
  let overlap = 0
  for (const tok of ta) if (tb.has(tok)) overlap += 1
  return overlap / Math.min(ta.size, tb.size)
}
