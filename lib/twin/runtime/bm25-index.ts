/**
 * Per-twin BM25 keyword index for the runtime hybrid-retrieval path.
 *
 * Reuses the shared RAG toolkit's `BM25Index` (`lib/ai/rag/hybrid-search.ts`)
 * — tuned k1/b + CJK-aware tokenisation — rather than re-implementing keyword
 * scoring. The index is keyed by each chunk's `vectorDocId` so its result ids
 * line up 1:1 with vector-store hits for Reciprocal Rank Fusion.
 *
 * Indexes are cached per twin and rebuilt only when the twin's chunk corpus
 * changes (cheap `{count, latestCreatedAt}` signal from `getTwinChunksVersion`,
 * not a full table load). A small LRU cap bounds memory; the active twin's
 * index survives across chat turns so we tokenise the corpus once, not per turn.
 *
 * We score the REDACTED chunk text — the same text the embedder and the model
 * see — so the keyword and vector lanes agree on what's in the corpus.
 */

import { BM25Index } from "@cognia/rag/hybrid-search"
import { getTwinChunksVersion, listTwinChunksByTwin } from "@/lib/db/twin-chunks"

interface CachedIndex {
  index: BM25Index
  /** `${count}:${latestCreatedAt}` — rebuild when this changes. */
  signature: string
}

const cache = new Map<string, CachedIndex>()
const MAX_CACHED_TWINS = 3

function signatureOf(version: { count: number; latestCreatedAt: number }): string {
  return `${version.count}:${version.latestCreatedAt}`
}

async function getTwinBm25Index(twinId: string): Promise<BM25Index> {
  const signature = signatureOf(await getTwinChunksVersion(twinId))
  const cached = cache.get(twinId)
  if (cached && cached.signature === signature) {
    // Refresh LRU recency (most-recently-used moves to the end).
    cache.delete(twinId)
    cache.set(twinId, cached)
    return cached.index
  }

  const chunks = await listTwinChunksByTwin(twinId)
  const index = new BM25Index()
  for (const chunk of chunks) {
    if (!chunk.vectorDocId) continue
    index.addDocument(chunk.vectorDocId, chunk.contentRedacted || chunk.content)
  }

  cache.set(twinId, { index, signature })
  // Evict the oldest entries beyond the cap.
  while (cache.size > MAX_CACHED_TWINS) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  return index
}

export interface TwinKeywordHit {
  /** The chunk's `vectorDocId` — aligns with vector-store hit ids for fusion. */
  id: string
  score: number
}

/**
 * BM25 keyword search over a twin's chunk corpus. Returns up to `limit` hits
 * keyed by `vectorDocId`. Empty when the query is blank, the limit is
 * non-positive, or the twin has no indexable chunks.
 */
export async function keywordSearch(
  twinId: string,
  query: string,
  limit: number
): Promise<TwinKeywordHit[]> {
  if (!query.trim() || limit <= 0) return []
  const index = await getTwinBm25Index(twinId)
  if (index.size() === 0) return []
  return index.search(query, limit)
}

/** Test hook — drop all cached indexes so cases don't leak corpus state. */
export function __resetTwinBm25Cache(): void {
  cache.clear()
}
