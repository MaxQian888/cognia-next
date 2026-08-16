/**
 * Global-search engine (ADR-0129).
 *
 * `runGlobalSearch` fans a parsed query out to the providers that belong to
 * the effective scope, runs them concurrently under one `AbortSignal`, and
 * folds their answers into ordered groups. A provider that throws yields an
 * errored group, never a failed run — one broken store must not blank the
 * dialog for every other kind.
 *
 * Group order in the *All* scope: kind priority (`KIND_PRIORITY`) nudged by
 * each group's best score, so a strong conversation hit still beats a weak
 * command even though commands come first by default. Scoped tabs keep the
 * static order — the user chose the tab, the ranking inside a group is enough.
 */

import { kindsToRun, effectiveScope } from "./query-parser"
import { providersForKinds } from "./registry"
import { compareByScore } from "./scoring"
import {
  KIND_PRIORITY,
  type GlobalSearchContext,
  type GlobalSearchCoverage,
  type GlobalSearchGroup,
  type GlobalSearchItem,
  type GlobalSearchOutcome,
  type GlobalSearchProvider,
  type GlobalSearchProviderResult,
  type GlobalSearchScope,
  type ParsedGlobalSearchQuery,
} from "./types"

/** Items shown per group in the *All* scope before "show all". */
export const ALL_SCOPE_GROUP_LIMIT = 5
/** Message hits get one more row in *All*: they are what most searches are for. */
export const ALL_SCOPE_MESSAGE_LIMIT = 6
/** Items fetched per group inside a scoped tab. */
export const SCOPED_GROUP_LIMIT = 30
/** Empty-query suggestions per provider. */
export const SUGGEST_LIMIT = 6

/** How much a perfect best score can pull a group ahead (in priority slots). */
const SCORE_PULL = 3

export interface RunGlobalSearchOptions {
  signal?: AbortSignal
  /** Override the per-group limit (a "show more" click raises it). */
  limit?: number
  /** Providers to consult; defaults to the registry filtered by scope. */
  providers?: readonly GlobalSearchProvider[]
  now?: () => number
}

const COVERAGE_RANK: Record<GlobalSearchCoverage, number> = {
  complete: 0,
  partial: 1,
  indexing: 2,
}

export function worstCoverage(
  a: GlobalSearchCoverage,
  b: GlobalSearchCoverage
): GlobalSearchCoverage {
  return COVERAGE_RANK[a] >= COVERAGE_RANK[b] ? a : b
}

function groupLimit(
  provider: GlobalSearchProvider,
  scope: GlobalSearchScope,
  override: number | undefined
): number {
  if (override !== undefined) return override
  if (scope !== "all") return SCOPED_GROUP_LIMIT
  return provider.kind === "message" ? ALL_SCOPE_MESSAGE_LIMIT : ALL_SCOPE_GROUP_LIMIT
}

function toGroup(
  provider: GlobalSearchProvider,
  result: GlobalSearchProviderResult,
  limit: number
): GlobalSearchGroup {
  const items = [...result.items].sort(compareByScore).slice(0, limit)
  const total = Math.max(result.total ?? result.items.length, items.length)
  return {
    kind: provider.kind,
    providerId: provider.id,
    items,
    bestScore: items.length > 0 ? items[0]!.score : 0,
    total,
    truncated: Boolean(result.truncated) || total > items.length,
    coverage: result.coverage ?? "complete",
  }
}

function errorGroup(provider: GlobalSearchProvider, cause: unknown): GlobalSearchGroup {
  return {
    kind: provider.kind,
    providerId: provider.id,
    items: [],
    bestScore: 0,
    total: 0,
    truncated: false,
    coverage: "partial",
    error: cause instanceof Error ? cause.message : String(cause),
  }
}

/**
 * Static kind priority, nudged by best score when `ranked` (the *All* scope
 * with a query). Suggestions and scoped tabs keep the static order.
 */
export function orderGroups(groups: GlobalSearchGroup[], ranked: boolean): GlobalSearchGroup[] {
  const key = (g: GlobalSearchGroup) =>
    ranked ? KIND_PRIORITY[g.kind] - g.bestScore * SCORE_PULL : KIND_PRIORITY[g.kind]
  return [...groups].sort((a, b) => key(a) - key(b) || a.providerId.localeCompare(b.providerId))
}

/**
 * Run a non-empty query. Groups with no items and no error are dropped so the
 * list only shows kinds that answered.
 */
export async function runGlobalSearch(
  parsed: ParsedGlobalSearchQuery,
  ctx: GlobalSearchContext,
  { signal, limit, providers, now = Date.now }: RunGlobalSearchOptions = {}
): Promise<GlobalSearchOutcome> {
  const started = now()
  const scope = effectiveScope(parsed, ctx.scope)
  const scopedCtx: GlobalSearchContext = ctx.scope === scope ? ctx : { ...ctx, scope }
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener("abort", onAbort, { once: true })
  }
  const targets = providers ?? providersForKinds(kindsToRun(parsed, ctx.scope))

  const settled = await Promise.all(
    targets.map(async (provider) => {
      const perGroup = groupLimit(provider, scope, limit)
      try {
        const result = await provider.search({
          query: parsed,
          ctx: scopedCtx,
          limit: perGroup,
          signal: controller.signal,
        })
        return toGroup(provider, result, perGroup)
      } catch (cause) {
        if (controller.signal.aborted) return null
        return errorGroup(provider, cause)
      }
    })
  )
  signal?.removeEventListener("abort", onAbort)

  const groups = orderGroups(
    settled.filter(
      (g): g is GlobalSearchGroup => g !== null && (g.items.length > 0 || g.error !== undefined)
    ),
    scope === "all"
  )
  let coverage: GlobalSearchCoverage = "complete"
  let totalHits = 0
  for (const group of groups) {
    coverage = worstCoverage(coverage, group.coverage)
    totalHits += group.total
  }
  return {
    groups,
    totalHits,
    coverage,
    tookMs: Math.max(0, now() - started),
    aborted: controller.signal.aborted,
  }
}

/**
 * Empty-query suggestions: every provider in scope that implements
 * `suggest`, in static kind order. Failures are dropped silently — an empty
 * palette is a fine fallback for a suggestion.
 */
export async function runGlobalSearchSuggestions(
  ctx: GlobalSearchContext,
  { signal, providers, limit = SUGGEST_LIMIT }: RunGlobalSearchOptions = {}
): Promise<GlobalSearchGroup[]> {
  const controller = new AbortController()
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener("abort", () => controller.abort(), { once: true })
  const empty: ParsedGlobalSearchQuery = { raw: "", text: "", needle: "", filters: {}, tokens: [] }
  const targets = (providers ?? providersForKinds(kindsToRun(empty, ctx.scope))).filter(
    (p) => typeof p.suggest === "function"
  )
  const settled: Array<GlobalSearchGroup | null> = await Promise.all(
    targets.map(async (provider): Promise<GlobalSearchGroup | null> => {
      try {
        const items: GlobalSearchItem[] = await provider.suggest!({
          ctx,
          limit,
          signal: controller.signal,
        })
        if (items.length === 0) return null
        const sliced = items.slice(0, limit)
        return {
          kind: provider.kind,
          providerId: provider.id,
          items: sliced,
          bestScore: sliced[0]?.score ?? 0,
          total: items.length,
          truncated: items.length > sliced.length,
          coverage: "complete" as const,
        }
      } catch {
        return null
      }
    })
  )
  return orderGroups(
    settled.filter((g): g is GlobalSearchGroup => g !== null),
    false
  )
}
