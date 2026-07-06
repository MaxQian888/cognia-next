/**
 * MCP tool handler — `rag_search`.
 *
 * Chunk-level keyword retrieval over two corpora, both **BM25** (no vector
 * backend — the MCP server runs in a bare Node sidecar that can't reach the
 * native vector store):
 *
 *   1. **Wiki RAG** (`scope: "cognia-self" | "user-repo" | "runtime" | "all"`)
 *      — section-level snippets over the generated wiki.
 *   2. **Twin RAG** (`scope: "twin"`) — the user's digital-twin chunks. Indexed
 *      by the REDACTED text (what the runtime would see); the ORIGINAL,
 *      un-redacted content is what we return (external agents see the user's
 *      real text — the point of the surface).
 *
 * Both corpora feed one shared pipeline (`runRagPipeline`) that composes the
 * `@cognia/rag` toolkit's pure stages around the shared `BM25Index`:
 *
 *   sanitize → validate → heuristic synonym expansion → per-variant BM25 →
 *   reciprocal-rank fusion → normalize → dedupe → (opt) lexical rerank →
 *   (opt) corrective-RAG grading → confidence → (opt) dynamic-context trim →
 *   citations → `<untrusted_content>` wrap.
 *
 * Every stage degrades to a no-op on empty input, so toggling a stage off (or
 * an empty corpus) still returns a correct, minimal result. Nothing here calls
 * the network or an LLM: `sanitizeQuery`, `expandWithSynonyms`, the heuristic
 * grader, `assessConfidence`, `DynamicContextManager`, and `formatCitations`
 * are all pure/local, and the rerank stage reuses the in-tree, key-free
 * `lexicalRerankScorer` (importing `@cognia/rag/reranker` would drag the whole
 * `@ai-sdk/*` provider graph into the sidecar bundle via its `cosineSimilarity`
 * import).
 *
 * Permission gating is the caller's job (`permission-gate.ts`); this handler
 * only does retrieval.
 */

import { listWikiArticlesByScope, listAllWikiArticles } from "@/lib/db/wiki-articles"
import { listWikiSectionsByArticle } from "@/lib/db/wiki-sections"
import { listTwinChunksByTwin } from "@/lib/db/twin-chunks"
import { listTwinSourcesByTwin } from "@/lib/db/twin-sources"
import {
  BM25Index,
  reciprocalRankFusion,
  normalizeScores,
  deduplicateResults,
} from "@cognia/rag/hybrid-search"
import { sanitizeQuery, validateRetrievalInput, assessConfidence } from "@cognia/rag/rag-guardrails"
import { expandWithSynonyms } from "@cognia/rag/query-expansion"
import { gradeRetrievedDocuments } from "@cognia/rag/retrieval-grader"
import { formatCitations, type Citation } from "@cognia/rag/citation-formatter"
import { DynamicContextManager } from "@cognia/rag/context-manager"
// Type-only — erased at compile time, so it does NOT pull the reranker's
// provider graph into the sidecar. The runtime reranker is `lexicalRerankScorer`.
import type { RerankResult } from "@cognia/rag/reranker"
import { lexicalRerankScorer } from "@/lib/twin/runtime/reranker"
import { wrapUntrusted } from "../untrusted"
import type { WikiScope } from "@/types/wiki"

export type RagSearchScope = WikiScope | "all" | "twin"

export interface RagSearchInput {
  query: string
  /** Defaults to "all". `"twin"` requires `rag:twin` scope. */
  scope?: RagSearchScope
  /** Defaults to 8; clamped to [1, 30]. */
  k?: number
  /** Apply the key-free lexical reranker over the fused pool. Default false. */
  rerank?: boolean
  /** Heuristic synonym query expansion for recall. Default true. */
  expand?: boolean
  /** Corrective-RAG relevance grading — drops low-relevance hits. Default true. */
  grade?: boolean
  /** Dynamic context-budget trimming (may shorten chunk content). Default false. */
  trim?: boolean
  /** Required when `scope === "twin"`. */
  twinId?: string
}

export interface RagSearchHit {
  filePath: string
  lineStart: number
  lineEnd: number
  /** Snippet body — the section's bodyMd or twin chunk content, `<untrusted_content>`-wrapped. */
  content: string
  /** Final rank score (BM25 / fused / rerank, depending on the pipeline path). */
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
  /** Formatted source citations for the returned chunks (never the raw context). */
  citations?: Citation[]
  /** Retrieval confidence assessment over the returned pool. */
  confidence?: { score: number; isLowConfidence: boolean; assessment: string }
  /** Corrective-RAG grading stats (present only when `grade` ran). */
  grading?: {
    totalGraded: number
    totalRelevant: number
    averageGrade: number
    fallbackUsed: boolean
  }
  /** The query variants actually searched (present only when expansion added any). */
  expandedQueries?: string[]
}

const MIN_K = 1
const MAX_K = 30
const DEFAULT_K = 8
/** Over-fetch multiplier so rerank/grading have a wider pool than the final k. */
const FETCH_MULTIPLIER = 3
/** Cap on expansion variants (original + synonyms) so recall stays bounded. */
const MAX_VARIANTS = 4

/** One indexed unit in a retrieval corpus (a wiki section or a twin chunk). */
interface CorpusItem {
  id: string
  /** Original content returned to the caller (un-redacted for twin). */
  content: string
  /** Metadata for grading title-match + confidence diversity + citation source. */
  metadata: Record<string, unknown>
  /** Skeleton hit (score filled in by the pipeline). */
  hit: Omit<RagSearchHit, "content" | "score"> & { content: string }
}

interface Corpus {
  index: BM25Index
  itemById: Map<string, CorpusItem>
  /** Total candidates examined before ranking (for "no result" diagnostics). */
  considered: number
}

interface PipelineOptions {
  k: number
  rerank: boolean
  expand: boolean
  grade: boolean
  trim: boolean
  /** Scope label passed to `validateRetrievalInput` as the collection name. */
  scopeLabel: string
}

export async function ragSearch(input: RagSearchInput): Promise<RagSearchOutput> {
  const query = input.query?.trim() ?? ""
  const scope = input.scope ?? "all"
  const k = clamp(input.k ?? DEFAULT_K, MIN_K, MAX_K)
  if (query.length === 0) return { chunks: [], considered: 0 }

  const opts: Omit<PipelineOptions, "scopeLabel"> = {
    k,
    rerank: input.rerank ?? false,
    expand: input.expand ?? true,
    grade: input.grade ?? true,
    trim: input.trim ?? false,
  }

  if (scope === "twin") {
    if (!input.twinId) {
      throw new Error("rag_search: scope='twin' requires twinId")
    }
    const corpus = await buildTwinCorpus(input.twinId)
    if (!corpus) return { chunks: [], considered: 0 }
    return runRagPipeline(query, corpus, { ...opts, scopeLabel: "twin" })
  }

  const corpus = await buildWikiCorpus(scope)
  return runRagPipeline(query, corpus, { ...opts, scopeLabel: scope })
}

// ─────────────────────────────────────────────────────────────────────────────
// Corpus builders
// ─────────────────────────────────────────────────────────────────────────────

async function buildWikiCorpus(scope: Exclude<RagSearchScope, "twin">): Promise<Corpus> {
  const articles =
    scope === "all" ? await listAllWikiArticles() : await listWikiArticlesByScope(scope)
  const index = new BM25Index()
  const itemById = new Map<string, CorpusItem>()
  let considered = 0
  for (const article of articles) {
    const sections = await listWikiSectionsByArticle(article.id)
    for (const section of sections) {
      considered++
      const ref = section.sourceRefs[0]
      // Fold heading + body + cited file paths into the indexed text so a query
      // token that hits a heading or a file path still ranks the section (the
      // old hand-rolled `pathBoost`, now a first-class BM25 signal).
      const paths = section.sourceRefs.map((r) => r.filePath).join(" ")
      const bm25Text = `${section.headingPath.join(" ")}\n${section.bodyMd}\n${paths}`
      const item: CorpusItem = {
        id: section.id,
        content: section.bodyMd,
        metadata: {
          title: article.title,
          source: ref?.filePath || article.slug,
          documentId: article.slug,
        },
        hit: {
          articleSlug: article.slug,
          filePath: ref?.filePath ?? "",
          lineStart: ref?.lineStart ?? 0,
          lineEnd: ref?.lineEnd ?? 0,
          content: section.bodyMd,
        },
      }
      index.addDocument(item.id, bm25Text)
      itemById.set(item.id, item)
    }
  }
  return { index, itemById, considered }
}

async function buildTwinCorpus(twinId: string): Promise<Corpus | null> {
  const [chunks, sources] = await Promise.all([
    listTwinChunksByTwin(twinId),
    listTwinSourcesByTwin(twinId),
  ])
  if (chunks.length === 0) return null
  const sourceById = new Map(sources.map((s) => [s.id, s]))
  const index = new BM25Index()
  const itemById = new Map<string, CorpusItem>()
  for (const chunk of chunks) {
    const source = sourceById.get(chunk.sourceId)
    const title = source?.title ?? ""
    const item: CorpusItem = {
      id: chunk.id,
      content: chunk.content,
      metadata: { title, source: title || chunk.sourceId, documentId: chunk.sourceId },
      hit: {
        twinId,
        twinSourceId: chunk.sourceId,
        filePath: source?.title ?? chunk.sourceId,
        lineStart: 0,
        lineEnd: 0,
        content: chunk.content,
      },
    }
    // Index the REDACTED text (+ source title) — the original content is only
    // ever returned, never used to rank, so an external query can't fish for
    // redacted material via ranking.
    index.addDocument(item.id, `${chunk.contentRedacted || chunk.content}\n${title}`)
    itemById.set(item.id, item)
  }
  return { index, itemById, considered: chunks.length }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared retrieval pipeline
// ─────────────────────────────────────────────────────────────────────────────

async function runRagPipeline(
  query: string,
  corpus: Corpus,
  opts: PipelineOptions
): Promise<RagSearchOutput> {
  const considered = corpus.considered

  // 1. Sanitize — normalize whitespace, strip control chars + injection markers.
  const sanitized = sanitizeQuery(query).query
  if (sanitized.length === 0) return { chunks: [], considered }

  // 2. Validate the (query, collection) shape.
  if (!validateRetrievalInput(sanitized, opts.scopeLabel).valid) {
    return { chunks: [], considered }
  }

  // 3. Heuristic synonym expansion for recall (pure; `expandWithSynonyms`
  //    already includes the original at index 0).
  const variants = opts.expand
    ? dedupeStrings(expandWithSynonyms(sanitized)).slice(0, MAX_VARIANTS)
    : [sanitized]

  // 4. Per-variant BM25.
  const fetchLimit = Math.max(opts.k * FETCH_MULTIPLIER, opts.k)
  const rankedLists = variants.map((v) => corpus.index.search(v, fetchLimit))

  // 5. Fuse variants via Reciprocal Rank Fusion (original query dominant).
  const fused =
    rankedLists.length > 1
      ? reciprocalRankFusion(
          rankedLists,
          variants.map((_, i) => (i === 0 ? 1 : 0.6)),
          60
        )
      : rankedLists[0]
  if (fused.length === 0) return { chunks: [], considered }

  // 6. Normalize to 0..1 (the grader + confidence assume that range).
  // 7. Dedupe across the fused/variant lists (keeps the higher score per id).
  const deduped = deduplicateResults(normalizeScores(fused))

  // 8. Materialize into the `@cognia/rag` RerankResult shape the downstream
  //    stages consume. `content` is the ORIGINAL (returned) content.
  let ranked: RerankResult[] = []
  for (const r of deduped) {
    const item = corpus.itemById.get(r.id)
    if (!item) continue
    ranked.push({
      id: r.id,
      content: item.content,
      metadata: item.metadata,
      originalScore: r.score,
      rerankScore: r.score,
    })
  }

  // 9. Optional lexical rerank (key-free, in-tree) — re-scores the pool.
  if (opts.rerank) {
    ranked = ranked
      .map((doc) => ({
        ...doc,
        rerankScore: lexicalRerankScorer(sanitized, {
          id: doc.id,
          content: doc.content,
          score: doc.rerankScore,
        }),
      }))
      .sort((a, b) => b.rerankScore - a.rerankScore)
  }

  // 10. Optional corrective-RAG grading — drops low-relevance hits (heuristic,
  //     no LLM). `keep_best` guarantees a non-empty pool never empties.
  let grading: RagSearchOutput["grading"]
  if (opts.grade) {
    const result = await gradeRetrievedDocuments(sanitized, ranked, {
      useLLM: false,
      fallbackStrategy: "keep_best",
      minChunks: Math.min(3, opts.k),
      maxChunksToGrade: ranked.length,
    })
    ranked = result.relevantDocuments
    grading = {
      totalGraded: result.stats.totalGraded,
      totalRelevant: result.stats.totalRelevant,
      averageGrade: result.stats.averageGrade,
      fallbackUsed: result.stats.fallbackUsed,
    }
  }

  // 11. Confidence assessment over the surviving pool.
  const confidence = assessConfidence(ranked)

  // 12. Optional dynamic context-budget trim (may shorten/reorder content).
  //     Off by default → return k full chunks.
  const selected = opts.trim ? trimToBudget(sanitized, ranked, opts.k) : ranked.slice(0, opts.k)

  // 13. Citations for the selected chunks (return `.citations` only — its
  //     `.context` re-embeds RAW unwrapped content, which would defeat R7).
  const citations = formatCitations(ranked.slice(0, opts.k), {
    style: "simple",
    includeRelevanceScore: true,
    maxCitations: opts.k,
  }).citations

  // 14. Reconstruct hits, wrapping content as untrusted (ADR-0008 R7).
  const scoreById = new Map(ranked.map((r) => [r.id, r.rerankScore]))
  const chunks: RagSearchHit[] = []
  for (const sel of selected) {
    const item = corpus.itemById.get(sel.id)
    if (!item) continue
    chunks.push({
      ...item.hit,
      content: wrapUntrusted(sel.content),
      score: scoreById.get(sel.id) ?? 0,
    })
  }
  chunks.sort((a, b) => b.score - a.score)

  return {
    chunks: chunks.slice(0, opts.k),
    considered,
    ...(citations.length > 0 ? { citations } : {}),
    confidence: {
      score: confidence.confidence,
      isLowConfidence: confidence.isLowConfidence,
      assessment: confidence.assessment,
    },
    ...(grading ? { grading } : {}),
    ...(opts.expand && variants.length > 1 ? { expandedQueries: variants } : {}),
  }
}

/** Dynamic context-budget trim — returns `{id, content}` in the manager's order. */
function trimToBudget(
  query: string,
  ranked: RerankResult[],
  k: number
): Array<{ id: string; content: string }> {
  const cm = new DynamicContextManager({ maxChunks: k })
  const target = cm.calculateOptimalContextLength(query, ranked)
  return cm
    .selectOptimalChunks(ranked, target)
    .chunks.map((c) => ({ id: c.id, content: c.content }))
}

function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of values) {
    const key = v.trim()
    if (key.length === 0 || seen.has(key)) continue
    seen.add(key)
    out.push(v)
  }
  return out
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min
  return Math.max(min, Math.min(max, Math.trunc(value)))
}

export const __TESTING__ = {
  clamp,
  dedupeStrings,
  buildWikiCorpus,
  buildTwinCorpus,
  runRagPipeline,
  MIN_K,
  MAX_K,
  DEFAULT_K,
}
