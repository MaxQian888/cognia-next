/**
 * RepoMapAgent — pure heuristic ranking of modules.
 *
 * Aider's classic implementation runs personalized PageRank over a
 * tree-sitter import graph. That's the right long-term answer; for Phase 1
 * MVP we ship a simpler size-based heuristic that's good enough to bias
 * `wiki_search` toward the architecturally heavy modules without the
 * static-analysis dependency.
 *
 * Heuristic score per module:
 *   raw = totalLines × file-type boost
 *     • index.ts / page.tsx / layout.tsx / route.ts files boost ×1.5
 *     • README.md / mod.rs files boost ×1.5
 *     • everything else ×1.0
 *   pageRank = raw / max(raw across all modules)   // normalize 0..1
 *
 * Real PageRank lands in Phase 2 alongside the import-graph extractor.
 */

import type { CodeChunk, ModuleStat } from "../types"

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
export function buildModuleStats(chunks: readonly CodeChunk[]): ModuleStat[] {
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
  return raws
    .map<ModuleStat>((r) => ({
      module: r.module,
      filePaths: r.paths,
      totalLines: r.lines,
      totalTokens: r.tokens,
      pageRank: maxRaw === 0 ? 0 : r.raw / maxRaw,
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
