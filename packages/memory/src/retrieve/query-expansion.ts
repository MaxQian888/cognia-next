/**
 * Retrieval query-expansion helper for the memory BM25 keyword leg.
 *
 * Vendored from `lib/ai/retrieval/query-expansion.ts` so the memory core has no
 * `@/` app import. The underlying heuristic synonym engine still comes from the
 * already-extracted `@cognia/rag/query-expansion` package — this is only the
 * thin "append NEW synonym terms" wrapper around it.
 *
 * Pure + local: no network, no LLM, no I/O. The LLM-backed expansion legs
 * (HyDE / step-back) live app-side where the LLM client + PII gate exist.
 */

import { expandWithSynonyms } from "@cognia/rag/query-expansion"

/**
 * Return `text` with any NEW synonym terms appended, so a BM25 search widens
 * recall (verbatim ids, alternate verbs) while the original phrasing stays
 * dominant. Returns the trimmed input unchanged when there are no synonyms to
 * add (or the input is blank).
 */
export function buildExpandedKeywordQuery(text: string): string {
  const base = text.trim()
  if (base.length === 0) return base

  // `expandWithSynonyms` returns `[original, ...variants]`; collect the terms
  // that appear in the variants but not in the original.
  const baseTerms = new Set(base.toLowerCase().split(/\s+/).filter(Boolean))
  const appended = new Set<string>()
  for (const variant of expandWithSynonyms(base)) {
    if (variant === base) continue
    for (const raw of variant.split(/\s+/)) {
      const term = raw.trim()
      if (term.length > 1 && !baseTerms.has(term.toLowerCase())) {
        appended.add(term)
      }
    }
  }

  return appended.size > 0 ? `${base} ${[...appended].join(" ")}` : base
}
