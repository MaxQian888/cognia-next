/**
 * MCP tool handlers — wiki domain.
 *
 * Two tools:
 *   • `wiki_search(query, scope?, k?)` — hybrid text-rank over `wikiArticles`,
 *     returns top-K summaries with slug + module.
 *   • `wiki_read(slug)` — fetches one article's full Markdown body.
 *
 * The handlers are pure(-ish) — they hit Dexie via the v17 CRUD modules
 * but never touch the network or LLM directly. The MCP server skeleton
 * (lib/external-bridge/mcp-server) handles the protocol envelope; this
 * module just owns input validation + retrieval logic.
 *
 * Permission gating is enforced one layer up so the handlers themselves
 * stay independently testable.
 */

import {
  getWikiArticleBySlug,
  listAllWikiArticles,
  listWikiArticlesByScope,
} from "@/lib/db/wiki-articles"
import type { WikiArticle, WikiScope, WikiSourceRef } from "@/types/wiki"

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

  const tokens = tokenize(query)
  const ranked = candidates
    .map((article) => ({ article, score: scoreArticle(article, tokens) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)

  return {
    considered: candidates.length,
    results: ranked.map(({ article, score }) => ({
      ...toHit(article),
      score,
    })),
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

/**
 * Token-overlap ranking. Each article's title/module/summary contribute
 * weighted matches; pageRank is a tie-breaker. This is a deliberate MVP
 * simplification — once the orchestrator wires real embeddings (M2 / Phase
 * 2), we'll switch to hybrid (BM25 + dense vector cosine).
 */
function scoreArticle(a: WikiArticle, tokens: readonly string[]): number {
  if (tokens.length === 0) return 0
  const title = tokenize(a.title)
  const moduleTokens = tokenize(a.module)
  const summary = tokenize(a.summary)
  const titleHits = countHits(title, tokens)
  const moduleHits = countHits(moduleTokens, tokens)
  const summaryHits = countHits(summary, tokens)
  const raw = titleHits * 4 + moduleHits * 3 + summaryHits * 1
  if (raw === 0) return 0
  // Add pageRank as a small tie-breaker (0..0.5 boost).
  return raw + a.pageRank * 0.5
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s/.\\:_\-`,!?;()[\]{}<>"']+/)
    .filter((t) => t.length > 1)
}

function countHits(haystack: readonly string[], needles: readonly string[]): number {
  if (haystack.length === 0 || needles.length === 0) return 0
  const set = new Set(haystack)
  let hits = 0
  for (const n of needles) {
    if (set.has(n)) hits++
  }
  return hits
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
 */
export async function wikiRead(input: WikiReadInput): Promise<WikiReadOutput | undefined> {
  const slug = input.slug?.trim() ?? ""
  if (slug.length === 0) return undefined
  const article = await getWikiArticleBySlug(slug)
  if (!article) return undefined
  return {
    slug: article.slug,
    title: article.title,
    module: article.module,
    scope: article.scope,
    summary: article.summary,
    contentMd: article.contentMd,
    sourceRefs: article.sourceRefs,
    generatedAt: article.generatedAt,
  }
}

export const __TESTING__ = { tokenize, scoreArticle, countHits, clamp, MIN_K, MAX_K, DEFAULT_K }
