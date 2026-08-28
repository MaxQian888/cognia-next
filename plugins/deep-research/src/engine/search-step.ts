/**
 * Search step: run the (already rewritten) queries, dedup results by exact URL
 * and then semantically by embedding, and add the survivors to the unread
 * candidate pool. Embedding dedup is best-effort — if `embed` throws we keep
 * the exact-URL-deduped set.
 */
import type { EngineDeps, SearchHit } from "../types"
import { isFatalResearchError } from "../errors"
import { normalizeUrl } from "../lib/url"
import { dedupeByEmbedding } from "../lib/vector"
import type { ResearchState } from "./workspace"

export async function runSearchStep(
  queries: string[],
  state: ResearchState,
  deps: EngineDeps
): Promise<{ added: SearchHit[]; tokens: number }> {
  const fresh = await gatherFreshHits(queries, state, deps)
  const deduped = await semanticDedup(fresh, deps)
  state.candidates.push(...deduped)
  return { added: deduped, tokens: 0 }
}

async function gatherFreshHits(
  queries: string[],
  state: ResearchState,
  deps: EngineDeps
): Promise<SearchHit[]> {
  const known = new Set<string>([
    ...[...state.visitedUrls],
    ...state.candidates.map((c) => normalizeUrl(c.url)),
  ])
  const effective = queries.filter((q) => {
    const key = q.trim().toLowerCase()
    if (!key || state.searchedQueries.has(key)) return false
    state.searchedQueries.add(key)
    return true
  })
  // If every query was already issued, retry the first one anyway so a step
  // never becomes a complete no-op when the model insists on searching.
  const toRun = effective.length > 0 ? effective : queries.slice(0, 1)

  const fresh: SearchHit[] = []
  for (const query of toRun) {
    let hits: SearchHit[]
    try {
      hits = await deps.search(query, state.config.searchResultsPerQuery)
    } catch (err) {
      // A query that fails is noise; a search backend that CANNOT run is the
      // end of the run. Swallowing the second kind produced the worst possible
      // outcome — a confident answer synthesized from zero evidence, with no
      // hint that search never happened.
      if (isFatalResearchError(err)) throw err
      deps.logger?.warn(`search failed for "${query}"`, err)
      continue
    }
    for (const hit of hits) {
      const key = normalizeUrl(hit.url)
      if (known.has(key)) continue
      known.add(key)
      fresh.push(hit)
    }
  }
  return fresh
}

async function semanticDedup(hits: SearchHit[], deps: EngineDeps): Promise<SearchHit[]> {
  if (hits.length < 2) return hits
  try {
    const vectors = await deps.ai.embed(hits.map((h) => `${h.title}\n${h.content.slice(0, 300)}`))
    return dedupeByEmbedding(hits, vectors, 0.94)
  } catch (err) {
    deps.logger?.warn("embedding dedup skipped", err)
    return hits
  }
}
