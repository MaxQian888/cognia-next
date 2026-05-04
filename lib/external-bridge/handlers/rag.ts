/**
 * MCP tool handler — `rag_search`.
 *
 * For the Phase 1 MVP we run RAG over the wiki *sections* table because:
 *   1. Sections give chunk-level granularity without needing a configured
 *      vector store at the bridge layer.
 *   2. Bring-your-own-embedding lives in lib/twin (`twinChunks`) and that
 *      table is twin-scoped, so reusing it for repo-wide search would
 *      require synthetic twinIds + a vector backend that may not be
 *      configured at all.
 *   3. The MCP tool's contract — "give me code passages relevant to my
 *      query" — is satisfied by section-level snippets with their
 *      sourceRefs intact.
 *
 * Phase 2 expansion: when the user has a vector backend configured, this
 * handler swaps in the contextual-retrieval pipeline (`lib/ai/rag/...`)
 * and falls back to the BM25-ish path here when the backend is offline.
 */

import { listWikiArticlesByScope, listAllWikiArticles } from "@/lib/db/wiki-articles"
import { listWikiSectionsByArticle } from "@/lib/db/wiki-sections"
import type { WikiArticle, WikiScope, WikiSourceRef } from "@/types/wiki"

export interface RagSearchInput {
  query: string
  /** Defaults to "all". */
  scope?: WikiScope | "all"
  /** Defaults to 8; clamped to [1, 30]. */
  k?: number
  /** Currently a no-op; reserved for vector-backed reranking in Phase 2. */
  rerank?: boolean
}

export interface RagSearchHit {
  filePath: string
  lineStart: number
  lineEnd: number
  /** Snippet body — the section's bodyMd. */
  content: string
  /** Combined keyword score + parent article pageRank tie-break. */
  score: number
  /** The wiki article slug this section was sliced from. */
  articleSlug: string
}

export interface RagSearchOutput {
  chunks: RagSearchHit[]
  considered: number
}

const MIN_K = 1
const MAX_K = 30
const DEFAULT_K = 8

export async function ragSearch(input: RagSearchInput): Promise<RagSearchOutput> {
  const query = input.query?.trim() ?? ""
  const scope = input.scope ?? "all"
  const k = clamp(input.k ?? DEFAULT_K, MIN_K, MAX_K)
  if (query.length === 0) return { chunks: [], considered: 0 }

  const articles =
    scope === "all" ? await listAllWikiArticles() : await listWikiArticlesByScope(scope)
  const tokens = tokenize(query)

  const hits: RagSearchHit[] = []
  let considered = 0
  for (const article of articles) {
    const sections = await listWikiSectionsByArticle(article.id)
    for (const section of sections) {
      considered++
      const score = scoreSection(article, section.bodyMd, section.sourceRefs, tokens)
      if (score <= 0) continue
      const ref = section.sourceRefs[0]
      hits.push({
        articleSlug: article.slug,
        filePath: ref?.filePath ?? "",
        lineStart: ref?.lineStart ?? 0,
        lineEnd: ref?.lineEnd ?? 0,
        content: section.bodyMd,
        score,
      })
    }
  }
  hits.sort((a, b) => b.score - a.score)
  return { chunks: hits.slice(0, k), considered }
}

function scoreSection(
  article: WikiArticle,
  body: string,
  refs: readonly WikiSourceRef[],
  tokens: readonly string[]
): number {
  if (tokens.length === 0) return 0
  const haystack = tokenize(body)
  if (haystack.length === 0) return 0
  const set = new Set(haystack)
  let hits = 0
  for (const t of tokens) {
    if (set.has(t)) hits++
  }
  if (hits === 0) return 0
  // Boost slightly when the section cites a source file whose path itself
  // matches a query token — useful for "show me lib/twin" style queries.
  let pathBoost = 0
  for (const ref of refs) {
    const pathTokens = tokenize(ref.filePath)
    const pathSet = new Set(pathTokens)
    for (const t of tokens) if (pathSet.has(t)) pathBoost += 0.5
  }
  return hits + pathBoost + article.pageRank * 0.25
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s/.\\:_\-`,!?;()[\]{}<>"']+/)
    .filter((t) => t.length > 1)
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min
  return Math.max(min, Math.min(max, Math.trunc(value)))
}

export const __TESTING__ = { tokenize, scoreSection, clamp, MIN_K, MAX_K, DEFAULT_K }
