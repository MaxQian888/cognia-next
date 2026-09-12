/**
 * Search step: run the (already rewritten) queries, dedup results by exact URL
 * and then semantically by embedding, and add the survivors to the unread
 * candidate pool. Embedding dedup is best-effort — if `embed` throws we keep
 * the exact-URL-deduped set.
 *
 * Running a query also CLOSES the head of the gap queue when the issued queries
 * chase it, and records it as `activeGap` so freshly-read evidence attributes
 * to the (sub)question that surfaced it.
 */
import type { EngineDeps, SearchHit } from "../types"
import { isFatalResearchError } from "../errors"
import { domainOf, normalizeUrl } from "../lib/url"
import { dedupeByEmbedding } from "../lib/vector"
import { MAX_CANDIDATES, type ResearchState } from "./workspace"

export async function runSearchStep(
  queries: string[],
  state: ResearchState,
  deps: EngineDeps
): Promise<{ added: SearchHit[]; tokens: number }> {
  const { hits: fresh, issued } = await gatherFreshHits(queries, state, deps)
  closeChasedGap(state, issued)
  const deduped = await semanticDedup(fresh, deps)
  state.candidates.push(...deduped)
  // The pool is a FIFO of unread sources; past the cap the tail is noise the
  // controller never reaches anyway.
  if (state.candidates.length > MAX_CANDIDATES) {
    state.candidates.length = MAX_CANDIDATES
  }
  return { added: deduped, tokens: 0 }
}

/**
 * Diversity cap: at most this many hits per domain per issued query. The cap
 * is per query (not per batch) so a legitimately strong domain can still
 * appear once per angle of a multi-query step.
 */
export const MAX_PER_DOMAIN = 2

/** Query dedup key: case- and whitespace-insensitive. */
export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ")
}

/**
 * Close the head gap when one of the issued queries actually chases it (exact
 * or substring match either way). `activeGap` falls back to the first issued
 * query — the closest honest description of what the evidence answers — and to
 * the original question when nothing ran.
 */
function closeChasedGap(state: ResearchState, issued: string[]): void {
  const head = state.gapQueue[0]
  const headKey = head === undefined ? undefined : normalizeQuery(head)
  const chased =
    headKey !== undefined &&
    issued.some((q) => {
      const key = normalizeQuery(q)
      return key === headKey || key.includes(headKey) || headKey.includes(key)
    })
  if (chased) {
    state.gapQueue.shift()
    state.activeGap = head
  } else {
    state.activeGap = issued[0] ?? state.question
  }
}

async function gatherFreshHits(
  queries: string[],
  state: ResearchState,
  deps: EngineDeps
): Promise<{ hits: SearchHit[]; issued: string[] }> {
  const known = new Set<string>([
    ...[...state.visitedUrls],
    ...state.candidates.map((c) => normalizeUrl(c.url)),
  ])
  const effective = queries.filter((q) => {
    const key = normalizeQuery(q)
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
      // A query that fails is noise; a search backend that CANNOT run — or a
      // caller that cancelled — is the end of the run. Swallowing the first
      // kind produced the worst possible outcome — a confident answer
      // synthesized from zero evidence, with no hint that search never happened.
      if (isFatalResearchError(err) || deps.signal?.aborted) throw err
      deps.logger?.warn(`search failed for "${query}"`, err)
      continue
    }
    // One domain may not flood a single query's yield — eight Wikipedia hits
    // are one source read eight ways, not eight sources.
    const perDomain = new Map<string, number>()
    for (const hit of hits) {
      const key = normalizeUrl(hit.url)
      if (known.has(key)) continue
      const domain = domainOf(hit.url)
      const seen = perDomain.get(domain) ?? 0
      if (seen >= MAX_PER_DOMAIN) continue
      perDomain.set(domain, seen + 1)
      known.add(key)
      fresh.push(hit)
    }
  }
  return { hits: fresh, issued: toRun }
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
