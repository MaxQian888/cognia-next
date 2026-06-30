/**
 * RepoMapAgent — module ranking for `wiki_search` ordering.
 *
 * Two modes, selected by whether an import graph is supplied:
 *
 *   • Size heuristic (default / fallback) — `raw = totalLines × file-type
 *     boost`, normalized 0..1. index/page/layout/route + README/mod.rs files
 *     boost ×1.5. Cheap, no static analysis.
 *
 *   • PageRank (Phase 2, when `opts.importGraph` is provided) — Aider-style
 *     personalized PageRank over the module import graph, blended with the size
 *     heuristic as a tiebreak. Modules that many others import rank up. This is
 *     the long-promised replacement for the size-only heuristic; the import
 *     graph is built in the renderer by `buildImportGraph` (the heavyweight
 *     tree-sitter graph stays sidecar-side).
 *
 * The single-argument call is byte-for-byte the original heuristic, so existing
 * callers/tests are unaffected; PageRank is purely additive and degrades back
 * to the heuristic whenever the graph is empty/unavailable.
 */

import type { CodeChunk, ModuleStat } from "../types"
import { personalizedPageRank, normalizeScores } from "./pagerank"

/** Weight given to PageRank vs. the size heuristic when blending. */
const PAGERANK_WEIGHT = 0.65

export interface RepoMapOptions {
  /** `importer → imported` module graph (from `buildImportGraph`). */
  importGraph?: ReadonlyMap<string, ReadonlySet<string>>
}

const BOOST_FILES = new Set([
  "index.ts",
  "index.tsx",
  "page.tsx",
  "layout.tsx",
  "route.ts",
  "mod.rs",
  "lib.rs",
  "main.rs",
  "README.md",
  "README.mdx",
])

function basenameOf(path: string): string {
  const norm = path.replace(/\\/g, "/")
  return norm.split("/").pop() ?? ""
}

/**
 * Aggregate per-module stats from raw chunks.
 *
 * Pure function: given the same chunks it always produces the same map.
 * Modules with zero chunks are simply absent from the result; the
 * orchestrator falls back to the file-walker's bucket list to render
 * placeholder articles for empty-but-existing modules.
 */
export function buildModuleStats(
  chunks: readonly CodeChunk[],
  opts: RepoMapOptions = {}
): ModuleStat[] {
  const byModule = new Map<
    string,
    { paths: Set<string>; lines: number; tokens: number; boost: number }
  >()

  for (const chunk of chunks) {
    let entry = byModule.get(chunk.module)
    if (!entry) {
      entry = { paths: new Set(), lines: 0, tokens: 0, boost: 1 }
      byModule.set(chunk.module, entry)
    }
    entry.paths.add(chunk.filePath)
    entry.lines += Math.max(0, chunk.lineEnd - chunk.lineStart + 1)
    entry.tokens += chunk.tokenCount
    if (BOOST_FILES.has(basenameOf(chunk.filePath))) {
      entry.boost = 1.5
    }
  }

  // Compute raw scores then normalize.
  const raws: { module: string; raw: number; paths: string[]; lines: number; tokens: number }[] = []
  for (const [module, agg] of byModule) {
    raws.push({
      module,
      raw: agg.lines * agg.boost,
      paths: Array.from(agg.paths).sort(),
      lines: agg.lines,
      tokens: agg.tokens,
    })
  }

  const maxRaw = raws.reduce((m, r) => Math.max(m, r.raw), 0)
  const sizeScore = (raw: number) => (maxRaw === 0 ? 0 : raw / maxRaw)

  // PageRank blend — only when an import graph is supplied AND it actually
  // connects something. Otherwise the score is exactly the legacy heuristic.
  const prNorm = opts.importGraph ? normalizeScores(personalizedPageRank(opts.importGraph)) : null
  const usePageRank = prNorm !== null && prNorm.size > 0

  return raws
    .map<ModuleStat>((r) => ({
      module: r.module,
      filePaths: r.paths,
      totalLines: r.lines,
      totalTokens: r.tokens,
      pageRank: usePageRank
        ? PAGERANK_WEIGHT * (prNorm!.get(r.module) ?? 0) + (1 - PAGERANK_WEIGHT) * sizeScore(r.raw)
        : sizeScore(r.raw),
    }))
    .sort((a, b) => b.pageRank - a.pageRank)
}

/**
 * Pick which chunks to include in a `ModuleArticleAgent` prompt within a
 * token budget. Greedy: take chunks in their original order until the
 * budget is exhausted; the orchestrator owns the "PageRank-rank chunks
 * before passing in" decision so this stays a pure utility.
 */
export function chunksWithinBudget(
  chunks: readonly CodeChunk[],
  budgetTokens: number
): CodeChunk[] {
  if (budgetTokens <= 0) return []
  const out: CodeChunk[] = []
  let used = 0
  for (const chunk of chunks) {
    if (used + chunk.tokenCount > budgetTokens) break
    out.push(chunk)
    used += chunk.tokenCount
  }
  return out
}

/** Test-only escape hatch so suites can override the boost set. */
export const __TESTING__ = { BOOST_FILES, basenameOf }
