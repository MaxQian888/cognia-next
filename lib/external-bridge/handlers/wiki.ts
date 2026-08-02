/**
 * MCP tool handlers — wiki domain.
 *
 * Two tools:
 *   • `wiki_search(query, scope?, k?)` — keyword (BM25) rank over `wikiArticles`
 *     (`title + module + summary`), returns top-K summaries with slug + module.
 *   • `wiki_read(slug)` — fetches one article's full Markdown body, wrapped in
 *     `<untrusted_content>` (ADR-0008 R7) so a downstream LLM never treats
 *     generated wiki prose as instructions.
 *
 * Ranking reuses the shared `BM25Index` from `@cognia/rag/hybrid-search` — the
 * same primitive the `rag_search` handler and the twin runtime use — so the two
 * knowledge surfaces rank consistently (IDF + length normalisation + CJK-aware
 * tokenisation) instead of the old hand-rolled token-overlap counter. PageRank
 * stays a stable secondary tie-break.
 *
 * The handlers are pure(-ish) — they hit Dexie via the v17 CRUD modules but
 * never touch the network or an LLM. The MCP server skeleton
 * (lib/external-bridge/mcp-server) handles the protocol envelope + permission
 * gate; this module owns input validation + retrieval logic.
 */

import {
  getWikiArticleBySlug,
  listAllWikiArticles,
  listWikiArticlesByScope,
} from "@/lib/db/wiki-articles"
import { BM25Index } from "@cognia/rag/hybrid-search"
import { wrapUntrusted } from "../untrusted"
import type { WikiArticle, WikiScope, WikiSourceRef } from "@/types/wiki"
import { SELF_CORPUS_ID } from "@/types/wiki"

// ─────────────────────────────────────────────────────────────────────────────
// wiki_search
// ─────────────────────────────────────────────────────────────────────────────

export interface WikiSearchInput {
  query: string
  /** Defaults to "all" (search every scope). */
  scope?: WikiScope | "all"
  /** Defaults to 5; clamped to [1, 20]. */
  k?: number
}

export interface WikiSearchHit {
  slug: string
  title: string
  module: string
  scope: WikiScope
  summary: string
  pageRank: number
  score: number
}

export interface WikiSearchOutput {
  results: WikiSearchHit[]
  /** Total candidates considered before ranking — for "no result" diagnostics. */
  considered: number
}

const MIN_K = 1
const MAX_K = 20
const DEFAULT_K = 5

export async function wikiSearch(input: WikiSearchInput): Promise<WikiSearchOutput> {
  const query = input.query?.trim() ?? ""
  const scope = input.scope ?? "all"
  const k = clamp(input.k ?? DEFAULT_K, MIN_K, MAX_K)

  const candidates =
    scope === "all" ? await listAllWikiArticles() : await listWikiArticlesByScope(scope)
  if (query.length === 0) {
    // No query → return top-K by pageRank as a sensible browse default.
    return {
      considered: candidates.length,
      results: candidates
        .slice()
        .sort((a, b) => b.pageRank - a.pageRank)
        .slice(0, k)
        .map(toHit),
    }
  }

  const bySlug = new Map(candidates.map((a) => [a.slug, a]))
  const index = new BM25Index()
  for (const article of candidates) {
    index.addDocument(article.slug, `${article.title}\n${article.module}\n${article.summary}`)
  }

  const ranked = index
    .search(query, candidates.length)
    // BM25 indexes each article under its slug, so `r.id` is the slug.
    .map((r) => ({ article: bySlug.get(r.id)!, score: r.score }))
    .filter((r) => r.article)
    // BM25 score first; pageRank as a stable secondary tie-break.
    .sort((a, b) => b.score - a.score || b.article.pageRank - a.article.pageRank)
    .slice(0, k)

  return {
    considered: candidates.length,
    results: ranked.map(({ article, score }) => ({ ...toHit(article), score })),
  }
}

function toHit(a: WikiArticle): WikiSearchHit {
  return {
    slug: a.slug,
    title: a.title,
    module: a.module,
    scope: a.scope,
    summary: a.summary,
    pageRank: a.pageRank,
    score: a.pageRank,
  }
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min
  return Math.max(min, Math.min(max, Math.trunc(value)))
}

// ─────────────────────────────────────────────────────────────────────────────
// wiki_read
// ─────────────────────────────────────────────────────────────────────────────

export interface WikiReadInput {
  slug: string
  /**
   * Which corpus to read from (v142). Defaults to Cognia's own tree, which is
   * the only corpus with content until user repos are registrable. A slug is
   * unique only within a corpus, so this must be explicit once it is not.
   */
  corpusId?: string
}

export interface WikiReadOutput {
  slug: string
  title: string
  module: string
  scope: WikiScope
  summary: string
  contentMd: string
  sourceRefs: WikiSourceRef[]
  generatedAt: number
}

/**
 * Returns `undefined` (NOT throws) when the slug is unknown — callers
 * map that to MCP's not-found shape. Throwing here would force every
 * caller to wrap in try/catch for the common case.
 *
 * `contentMd` is `<untrusted_content>`-wrapped (ADR-0008 R7): a coding agent
 * feeding the body back into a model must not have generated wiki prose treated
 * as instructions.
 */
export async function wikiRead(input: WikiReadInput): Promise<WikiReadOutput | undefined> {
  const slug = input.slug?.trim() ?? ""
  if (slug.length === 0) return undefined
  const article = await getWikiArticleBySlug(input.corpusId ?? SELF_CORPUS_ID, slug)
  if (!article) return undefined
  return {
    slug: article.slug,
    title: article.title,
    module: article.module,
    scope: article.scope,
    summary: article.summary,
    contentMd: wrapUntrusted(article.contentMd),
    sourceRefs: article.sourceRefs,
    generatedAt: article.generatedAt,
  }
}

export const __TESTING__ = { clamp, MIN_K, MAX_K, DEFAULT_K }
