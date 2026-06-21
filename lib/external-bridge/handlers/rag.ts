/**
 * MCP tool handler — `rag_search`.
 *
 * Two retrieval surfaces:
 *
 *   1. **Wiki RAG** (`scope: "cognia-self" | "user-repo" | "all"`) — the
 *      Phase 1 default. Section-level snippets over the generated wiki.
 *      Pure BM25-ish keyword scoring; no vector backend required.
 *   2. **Twin RAG** (`scope: "twin"`) — Phase 2 expansion that lights up
 *      the user's digital-twin chunks for external coding agents. Falls
 *      back to BM25 over Dexie when the configured vector backend isn't
 *      available, so a misconfigured embedding key doesn't lock external
 *      agents out of the surface.
 *
 * Permission gating is the caller's job (`permission-gate.ts`); this
 * handler only does retrieval. The `rag:twin` scope MUST be on the
 * enabledScopes list before the gate dispatches to us.
 */

import { listWikiArticlesByScope, listAllWikiArticles } from "@/lib/db/wiki-articles"
import { listWikiSectionsByArticle } from "@/lib/db/wiki-sections"
import { listTwinChunksByTwin } from "@/lib/db/twin-chunks"
import { listTwinSourcesByTwin } from "@/lib/db/twin-sources"
import { BM25Index } from "@cognia/rag/hybrid-search"
import type { WikiArticle, WikiScope, WikiSourceRef } from "@/types/wiki"

export type RagSearchScope = WikiScope | "all" | "twin"

export interface RagSearchInput {
  query: string
  /** Defaults to "all". `"twin"` requires `rag:twin` scope. */
  scope?: RagSearchScope
  /** Defaults to 8; clamped to [1, 30]. */
  k?: number
  /** Currently a no-op; reserved for vector-backed reranking in Phase 2. */
  rerank?: boolean
  /** Required when `scope === "twin"`. */
  twinId?: string
}

export interface RagSearchHit {
  filePath: string
  lineStart: number
  lineEnd: number
  /** Snippet body — the section's bodyMd or twin chunk content. */
  content: string
  /** Combined keyword score + parent article pageRank tie-break. */
  score: number
  /** The wiki article slug this section was sliced from (wiki only). */
  articleSlug?: string
  /** The twin source id this chunk came from (twin only). */
  twinSourceId?: string
  /** The twin id (twin only). */
  twinId?: string
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

  if (scope === "twin") {
    if (!input.twinId) {
      throw new Error("rag_search: scope='twin' requires twinId")
    }
    return ragSearchTwin(input.twinId, query, k)
  }

  return ragSearchWiki(scope, query, k)
}

async function ragSearchWiki(
  scope: Exclude<RagSearchScope, "twin">,
  query: string,
  k: number
): Promise<RagSearchOutput> {
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

/**
 * BM25 retrieval over the user's twin chunks for a single twinId.
 *
 * Reuses the shared RAG toolkit's `BM25Index` (IDF + length normalisation +
 * CJK-aware tokenisation) — the same primitive the twin RUNTIME hybrid path
 * uses — instead of a hand-rolled token-overlap count, so the two retrieval
 * surfaces rank consistently. Each chunk is indexed by the REDACTED text (what
 * the runtime would see) plus its source title, so a query token that hits the
 * title (e.g. "notes.md") still promotes that source's chunks. The *original*
 * content is what we return — external agents see the user's real text, which
 * is the point of the surface.
 */
async function ragSearchTwin(twinId: string, query: string, k: number): Promise<RagSearchOutput> {
  if (tokenize(query).length === 0) return { chunks: [], considered: 0 }

  const [chunks, sources] = await Promise.all([
    listTwinChunksByTwin(twinId),
    listTwinSourcesByTwin(twinId),
  ])
  if (chunks.length === 0) return { chunks: [], considered: 0 }
  const sourceById = new Map(sources.map((s) => [s.id, s]))

  const index = new BM25Index()
  for (const chunk of chunks) {
    const title = sourceById.get(chunk.sourceId)?.title ?? ""
    index.addDocument(chunk.id, `${chunk.contentRedacted || chunk.content}\n${title}`)
  }

  const chunkById = new Map(chunks.map((c) => [c.id, c]))
  const hits: RagSearchHit[] = []
  for (const ranked of index.search(query, k)) {
    const chunk = chunkById.get(ranked.id)
    if (!chunk) continue
    const source = sourceById.get(chunk.sourceId)
    hits.push({
      twinId,
      twinSourceId: chunk.sourceId,
      filePath: source?.title ?? chunk.sourceId,
      lineStart: 0,
      lineEnd: 0,
      content: chunk.content,
      score: ranked.score,
    })
  }
  return { chunks: hits, considered: chunks.length }
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
