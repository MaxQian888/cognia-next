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
import type { ResearchState } from "./workspace"

const DUP_THRESHOLD = 0.95

export async function runReadStep(
  urls: string[],
  state: ResearchState,
  deps: EngineDeps,
  readTopK: number
): Promise<{ added: KnowledgeItem[]; tokens: number }> {
  const targets = chooseTargets(urls, state, readTopK)
  const question = state.gapQueue[0] ?? state.question
  const readItems: KnowledgeItem[] = []

  for (const hit of targets) {
    state.visitedUrls.add(normalizeUrl(hit.url))
    state.candidates = state.candidates.filter((c) => normalizeUrl(c.url) !== normalizeUrl(hit.url))
    let content: string
    try {
      content = await deps.read(hit.url, hit)
    } catch (err) {
      // Same split as the search step: one unreadable page is skipped, but a
      // reader that is switched off or rate-limited ends the run rather than
      // letting the loop quietly answer from snippets alone.
      if (isFatalResearchError(err)) throw err
      deps.logger?.warn(`read failed for ${hit.url}`, err)
      continue
    }
    const trimmed = (content ?? "").trim()
    if (!trimmed) continue
    readItems.push({ url: hit.url, title: hit.title, content: trimmed, question })
  }

  const added = await dropDuplicates(readItems, state, deps)
  state.knowledge.push(...added)
  return { added, tokens: 0 }
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
