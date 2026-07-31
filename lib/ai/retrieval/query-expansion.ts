/**
 * Shared retrieval query-expansion helper.
 *
 * Wraps the (previously dormant) `@cognia/rag/query-expansion` heuristic
 * synonym engine into one small, pure function used by BOTH the twin runtime's
 * BM25 keyword leg (`apply-twin-context`) and the memory retriever's BM25 leg
 * (`lib/memory/retrieve/retriever`). Consolidating it here is the minimal step
 * toward the `TODO(retrieval)` unification in `retriever.ts` — the two hybrid
 * pipelines now share one recall-expansion primitive instead of each rolling
 * their own.
 *
 * Pure + local: no network, no LLM, no I/O. The LLM-backed expansion legs
 * (HyDE / step-back) live in the twin runtime where the twin's LLM client and
 * the PII gate are available.
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
