/**
 * Read step: fetch the chosen URLs' content, mark them visited, and add new
 * (non-duplicate) evidence to working memory. Reading is bounded by
 * `readTopK`. Knowledge dedup is semantic (embedding) with a best-effort
 * fallback to keeping everything when `embed` is unavailable.
 */
import type { EngineDeps, KnowledgeItem, SearchHit } from "../types"
import { isFatalResearchError } from "../errors"
import { normalizeUrl } from "../lib/url"
import { cosineSimilarity } from "../lib/vector"
import { MAX_KNOWLEDGE, type ResearchState } from "./workspace"

const DUP_THRESHOLD = 0.95

export async function runReadStep(
  urls: string[],
  state: ResearchState,
  deps: EngineDeps,
  readTopK: number
): Promise<{ added: KnowledgeItem[]; tokens: number }> {
  const targets = chooseTargets(urls, state, readTopK)
  // Attribute to the gap the last search actually chased, not whatever sits at
  // the head of the still-open queue.
  const question = state.activeGap ?? state.question

  // Every target is a committed read: mark visited and drop from the pool
  // before the fetches run in parallel.
  for (const hit of targets) {
    state.visitedUrls.add(normalizeUrl(hit.url))
    state.candidates = state.candidates.filter((c) => normalizeUrl(c.url) !== normalizeUrl(hit.url))
  }

  // Reads are independent — fetching them serially made the read step the
  // slowest move in the loop for no reason. `allSettled` keeps target order
  // and lets a per-page fault skip a source while a run-wide failure still
  // ends the run (same split as the search step: one dead page is noise, a
  // switched-off / rate-limited / cancelled reader is the end).
  const settled = await Promise.allSettled(targets.map((hit) => deps.read(hit.url, hit)))
  const readItems: KnowledgeItem[] = []
  for (const [i, outcome] of settled.entries()) {
    const hit = targets[i]
    if (outcome.status === "rejected") {
      if (isFatalResearchError(outcome.reason) || deps.signal?.aborted) throw outcome.reason
      deps.logger?.warn(`read failed for ${hit.url}`, outcome.reason)
      continue
    }
    const trimmed = (outcome.value ?? "").trim()
    if (!trimmed) continue
    readItems.push({
      url: hit.url,
      title: hit.title,
      content: trimmed,
      question,
      ...(hit.publishedDate ? { publishedDate: hit.publishedDate } : {}),
      ...(hit.credibility ? { credibility: hit.credibility } : {}),
    })
  }

  const added = await dropDuplicates(readItems, state, deps)
  const room = Math.max(0, MAX_KNOWLEDGE - state.knowledge.length)
  const kept = added.slice(0, room)
  if (kept.length < added.length) {
    deps.logger?.warn(`knowledge store full — dropped ${added.length - kept.length} item(s)`)
  }
  state.knowledge.push(...kept)
  return { added: kept, tokens: 0 }
}

/** Resolve the candidate hits to read: requested URLs first, else top of pool. */
function chooseTargets(urls: string[], state: ResearchState, readTopK: number): SearchHit[] {
  const requested = urls
    .map((u) => state.candidates.find((c) => normalizeUrl(c.url) === normalizeUrl(u)))
    .filter((c): c is SearchHit => c !== undefined)
  const pool = requested.length > 0 ? requested : state.candidates
  const seen = new Set<string>()
  const out: SearchHit[] = []
  for (const hit of pool) {
    const key = normalizeUrl(hit.url)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(hit)
    if (out.length >= readTopK) break
  }
  return out
}

async function dropDuplicates(
  items: KnowledgeItem[],
  state: ResearchState,
  deps: EngineDeps
): Promise<KnowledgeItem[]> {
  if (items.length === 0) return []
  const existing = state.knowledge.map((k) => k.content.slice(0, 500))
  const incoming = items.map((k) => k.content.slice(0, 500))
  try {
    const vectors = await deps.ai.embed([...existing, ...incoming])
    const keptVecs = vectors.slice(0, existing.length)
    const newVecs = vectors.slice(existing.length)
    const kept: KnowledgeItem[] = []
    items.forEach((item, i) => {
      const v = newVecs[i] ?? []
      const dup = keptVecs.some((kv) => cosineSimilarity(v, kv) >= DUP_THRESHOLD)
      if (!dup) {
        kept.push(item)
        keptVecs.push(v)
      }
    })
    return kept
  } catch (err) {
    deps.logger?.warn("knowledge dedup skipped", err)
    return items
  }
}
