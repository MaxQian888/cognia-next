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
import { DEMOTED_SCORE_FACTOR, scopedWorkspaceId } from "../workspace-scope"
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
  /**
   * How this list relates to workspaces. Omitted means "global" — settings,
   * navigation, devices — and nothing is filtered or re-ranked.
   *
   * `"filter"` for entities that BELONG to a workspace: out of scope they are
   * noise. `"demote"` for the definition layer, which is machine-wide and only
   * has a per-workspace preference — hiding a skill because this workspace
   * switched it off produces the worst search result there is, "I know I have
   * this and it is not there". See `lib/global-search/workspace-scope.ts`.
   */
  workspaceScope?: {
    mode: "filter" | "demote"
    /**
     * Whether the row belongs to the workspace being searched. `scopeId` is
     * `null` for "every workspace", which this is never asked about.
     *
     * One predicate rather than a column reader plus an escape hatch: a skill's
     * relationship to a workspace is the capability overlay, not a foreign key,
     * and two ways to express "belongs here" is how the two answers start
     * disagreeing. `byProjectId` builds the common column-backed case.
     */
    belongs: (row: T, ctx: GlobalSearchContext, scopeId: string) => boolean
  }
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
      const loaded = visible(await loadRows(ctx), ctx)
      if (signal.aborted) return { items: [] }
      const scopeId = spec.workspaceScope ? scopedWorkspaceId(query, ctx) : null
      const rows =
        spec.workspaceScope?.mode === "filter" && scopeId != null
          ? loaded.filter((row) => spec.workspaceScope!.belongs(row, ctx, scopeId))
          : loaded
      const { hits, total, truncated } = matchTitles(rows, query.needle, {
        getTitle: (row) => spec.getTitle(row, ctx),
        getSecondary: spec.getSecondary ? (row) => spec.getSecondary!(row, ctx) : undefined,
        getKeywords: spec.getKeywords ? (row) => spec.getKeywords!(row, ctx) : undefined,
        getTimestamp: spec.getTimestamp,
        now: ctx.now,
        limit,
        fuzzy: spec.fuzzy,
      })
      const items = hits.map((hit) => {
        const item = spec.toItem(hit, ctx, query)
        if (spec.workspaceScope?.mode !== "demote" || scopeId == null) return item
        // Demote by re-scoring the item rather than dropping the row: it stays
        // findable, just below everything this workspace actually uses.
        return spec.workspaceScope.belongs(hit.row, ctx, scopeId)
          ? item
          : { ...item, score: item.score * DEMOTED_SCORE_FACTOR }
      })
      return { items, total, truncated }
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
