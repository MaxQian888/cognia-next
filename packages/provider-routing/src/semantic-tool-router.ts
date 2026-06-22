/**
 * Semantic tool router (semantic-router analog).
 *
 * Embeds the user's query and scores every candidate plugin tool by MAX
 * cosine similarity against its route utterances (persisted
 * `toolRoutes` rows when present, the tool's own name+description
 * otherwise). `pruneToolsSemantica` keeps the top-K scoring tools above
 * the threshold plus pinned tools.
 *
 * Reliability contract: this module must NEVER block or fail a send —
 * any error (embedding engine unavailable, Dexie unreachable) returns
 * `null`, which callers treat as "skip pruning, expose everything".
 *
 * Default embedding engine: local transformers.js MiniLM — no API key,
 * fully offline; settings can point at any configured engine instead.
 */

import type { SemanticToolRoutingSettings, ToolRouteRecord } from "./routing-types"
import { getProviderRoutingRuntimeAdapters } from "./runtime-adapters"

export interface SemanticToolCandidate {
  name: string
  description?: string
  pluginId?: string
}

export interface SemanticPruneResult {
  kept: SemanticToolCandidate[]
  prunedCount: number
  /** Tool name → similarity score (debug/UI surfacing). */
  scores: Record<string, number>
}

/** Local, keyless default (same model family the vector store defaults to). */
export const DEFAULT_SEMANTIC_EMBEDDING = {
  provider: "transformersjs",
  model: "Xenova/all-MiniLM-L6-v2",
} as const

interface RouterDeps {
  listRoutes: () => Promise<ToolRouteRecord[]>
  /** Batch-embed texts with the configured engine. */
  embed: (
    texts: string[],
    config: { provider: string; model: string; dimensions?: number }
  ) => Promise<number[][]>
  /** Write computed vectors back onto a persisted route (best-effort). */
  cacheRouteEmbeddings: (id: string, embeddings: number[][], model: string) => Promise<void>
  cosine: (a: number[], b: number[]) => number
}

let depsOverride: RouterDeps | null = null

/** Test-only deps injection (pass null to restore defaults). */
export function __setSemanticToolRouterDepsForTesting(deps: RouterDeps | null): void {
  depsOverride = deps
}

async function defaultDeps(): Promise<RouterDeps> {
  const deps = getProviderRoutingRuntimeAdapters().semanticToolRouterDeps
  if (!deps) {
    throw new Error("Semantic tool router runtime dependencies are not wired")
  }
  return deps
}

/** In-memory utterance-vector cache, keyed by `${model}|${text}`. */
const vectorCache = new Map<string, number[]>()
const VECTOR_CACHE_CAP = 2000

function cacheKey(model: string, text: string): string {
  return `${model}|${text}`
}

function rememberVector(model: string, text: string, vector: number[]): void {
  if (vectorCache.size >= VECTOR_CACHE_CAP) {
    // Drop the oldest entry (Map preserves insertion order).
    const first = vectorCache.keys().next().value
    if (first !== undefined) vectorCache.delete(first)
  }
  vectorCache.set(cacheKey(model, text), vector)
}

/** Test-only: drop the in-memory vector cache. */
export function __resetSemanticVectorCacheForTesting(): void {
  vectorCache.clear()
}

/** The utterances scoring a candidate: its route rows or name+description. */
function utterancesFor(
  candidate: SemanticToolCandidate,
  byTool: Map<string, ToolRouteRecord>,
  byPlugin: Map<string, ToolRouteRecord>
): { texts: string[]; record?: ToolRouteRecord } {
  const toolRoute = byTool.get(candidate.name)
  if (toolRoute && toolRoute.utterances.length > 0) {
    return { texts: toolRoute.utterances, record: toolRoute }
  }
  const pluginRoute = candidate.pluginId ? byPlugin.get(candidate.pluginId) : undefined
  if (pluginRoute && pluginRoute.utterances.length > 0) {
    return { texts: pluginRoute.utterances, record: pluginRoute }
  }
  const derived = [candidate.name.replace(/[_-]+/g, " "), candidate.description ?? ""]
    .filter((t) => t.trim().length > 0)
    .map((t) => t.slice(0, 500))
  return { texts: derived }
}

export interface SemanticPruneInput {
  /** The user's query (recent prompt text). */
  query: string
  candidates: SemanticToolCandidate[]
  settings: SemanticToolRoutingSettings
}

/**
 * Score candidates against the query and pick the survivors. Returns
 * `null` whenever pruning should be skipped (no query, embedding engine
 * unavailable, fewer candidates than topK, any error).
 */
export async function pruneToolsSemantica(
  input: SemanticPruneInput
): Promise<SemanticPruneResult | null> {
  const { query, candidates, settings } = input
  if (!query.trim() || candidates.length === 0) return null
  const topK = Math.max(1, settings.topK)
  if (candidates.length <= topK) return null

  try {
    const deps = depsOverride ?? (await defaultDeps())
    const embeddingConfig = settings.embedding ?? DEFAULT_SEMANTIC_EMBEDDING
    const model = embeddingConfig.model

    // Route lookup maps (tool-level beats plugin-level).
    const routes = await deps.listRoutes()
    const byTool = new Map(routes.filter((r) => r.kind === "tool").map((r) => [r.refId, r]))
    const byPlugin = new Map(routes.filter((r) => r.kind === "plugin").map((r) => [r.refId, r]))

    // Collect every text that still needs a vector (cache + persisted
    // route embeddings count as hits), then batch-embed the misses.
    const perCandidate = candidates.map((candidate) => ({
      candidate,
      ...utterancesFor(candidate, byTool, byPlugin),
    }))
    const missing: string[] = []
    const seenMissing = new Set<string>()
    for (const { texts, record } of perCandidate) {
      const persisted =
        record?.embeddings && record.embeddingModel === model ? record.embeddings : undefined
      texts.forEach((text, i) => {
        if (persisted?.[i]) {
          rememberVector(model, text, persisted[i])
        } else if (!vectorCache.has(cacheKey(model, text)) && !seenMissing.has(text)) {
          seenMissing.add(text)
          missing.push(text)
        }
      })
    }

    const [queryVector] = await deps.embed([query.slice(0, 2000)], embeddingConfig)
    if (missing.length > 0) {
      const vectors = await deps.embed(missing, embeddingConfig)
      missing.forEach((text, i) => rememberVector(model, text, vectors[i]))
    }

    // Write fresh vectors back onto persisted routes (best-effort).
    for (const { texts, record } of perCandidate) {
      if (!record || (record.embeddings && record.embeddingModel === model)) continue
      const vectors = texts
        .map((text) => vectorCache.get(cacheKey(model, text)))
        .filter((v): v is number[] => Array.isArray(v))
      if (vectors.length === texts.length) {
        // Promise.resolve guards non-thenable sinks; failures are ignored.
        void Promise.resolve(deps.cacheRouteEmbeddings(record.id, vectors, model)).catch(() => {})
      }
    }

    // Score: max cosine across the candidate's utterance vectors.
    const scores: Record<string, number> = {}
    const scored = perCandidate.map(({ candidate, texts, record }) => {
      let best = -1
      for (const text of texts) {
        const vector = vectorCache.get(cacheKey(model, text))
        if (!vector) continue
        const similarity = deps.cosine(queryVector, vector)
        if (similarity > best) best = similarity
      }
      scores[candidate.name] = best
      const floor = record?.threshold ?? settings.threshold
      return { candidate, score: best, passes: best >= floor }
    })

    const pinned = new Set(settings.pinnedTools)
    const passing = scored
      .filter((s) => s.passes && !pinned.has(s.candidate.name))
      .sort((a, b) => b.score - a.score)
    // Nothing related at all → keep a small score-ordered safety floor so
    // the agent is never stranded with zero plugin tools.
    const ranked =
      passing.length > 0
        ? passing
        : [...scored]
            .filter((s) => !pinned.has(s.candidate.name))
            .sort((a, b) => b.score - a.score)
            .slice(0, Math.min(3, topK))

    const keep = new Set<string>(settings.pinnedTools)
    for (const { candidate } of ranked.slice(0, topK)) {
      keep.add(candidate.name)
    }

    const kept = candidates.filter((candidate) => keep.has(candidate.name))
    if (kept.length === candidates.length) return null
    return { kept, prunedCount: candidates.length - kept.length, scores }
  } catch {
    // Embedding engine unavailable / Dexie unreachable — never block a send.
    return null
  }
}
