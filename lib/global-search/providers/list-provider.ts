/**
 * Factory for "list-shaped" providers (ADR-0129): load a list once (cached
 * across keystrokes, dropped when the dialog opens), score names against the
 * needle, project hits into items. Skills, workflows, memories, templates,
 * plugins, MCP servers, scheduled tasks and inbox conversations are all this.
 */

import { createSearchCache, type SearchCache } from "../cache"
import type {
  GlobalSearchContext,
  GlobalSearchItem,
  GlobalSearchKind,
  GlobalSearchProvider,
  GlobalSearchProviderInput,
  ParsedGlobalSearchQuery,
} from "../types"
import { matchTitles, type TitleHit } from "./helpers"

export interface ListProviderSpec<T> {
  id: string
  kind: GlobalSearchKind
  /** Read the full list. Wrapped in a TTL cache unless `cache: false`. */
  load: (ctx: GlobalSearchContext) => Promise<readonly T[]> | readonly T[]
  cache?: boolean
  cacheTtlMs?: number
  getTitle: (row: T, ctx: GlobalSearchContext) => string
  getSecondary?: (row: T, ctx: GlobalSearchContext) => string | undefined
  getKeywords?: (row: T, ctx: GlobalSearchContext) => readonly string[] | undefined
  getTimestamp?: (row: T) => number | undefined
  /** Fuzzy subsequence fallback (default true; off for prose bodies). */
  fuzzy?: boolean
  /** Rows to skip entirely (e.g. archived workspaces). */
  include?: (row: T, ctx: GlobalSearchContext) => boolean
  toItem: (
    hit: TitleHit<T>,
    ctx: GlobalSearchContext,
    query: ParsedGlobalSearchQuery
  ) => GlobalSearchItem
  /** Optional empty-query suggestions. */
  suggest?: (rows: readonly T[], ctx: GlobalSearchContext, limit: number) => GlobalSearchItem[]
}

export interface ListProvider<T> extends GlobalSearchProvider {
  /** The underlying cache (null when `cache: false`), for tests / explicit invalidation. */
  cache: SearchCache<readonly T[]> | null
}

export function createListProvider<T>(spec: ListProviderSpec<T>): ListProvider<T> {
  // The cache's loader reads whichever ctx triggered the miss — right for
  // host-level lists, which is all this factory is used for.
  let latestCtx: GlobalSearchContext | null = null
  const cache =
    spec.cache === false
      ? null
      : createSearchCache(() => Promise.resolve(spec.load(latestCtx!)), { ttlMs: spec.cacheTtlMs })

  const loadRows = (ctx: GlobalSearchContext): Promise<readonly T[]> => {
    latestCtx = ctx
    return cache ? cache.get() : Promise.resolve(spec.load(ctx))
  }

  const visible = (rows: readonly T[], ctx: GlobalSearchContext): readonly T[] =>
    spec.include ? rows.filter((row) => spec.include!(row, ctx)) : rows

  return {
    id: spec.id,
    kind: spec.kind,
    cache,
    async search({ query, ctx, limit, signal }: GlobalSearchProviderInput) {
      const rows = visible(await loadRows(ctx), ctx)
      if (signal.aborted) return { items: [] }
      const { hits, total, truncated } = matchTitles(rows, query.needle, {
        getTitle: (row) => spec.getTitle(row, ctx),
        getSecondary: spec.getSecondary ? (row) => spec.getSecondary!(row, ctx) : undefined,
        getKeywords: spec.getKeywords ? (row) => spec.getKeywords!(row, ctx) : undefined,
        getTimestamp: spec.getTimestamp,
        now: ctx.now,
        limit,
        fuzzy: spec.fuzzy,
      })
      return { items: hits.map((hit) => spec.toItem(hit, ctx, query)), total, truncated }
    },
    ...(spec.suggest
      ? {
          async suggest({ ctx, limit }) {
            const rows = visible(await loadRows(ctx), ctx)
            return spec.suggest!(rows, ctx, limit)
          },
        }
      : {}),
  }
}
