/**
 * Pure search / filter / sort for the `/memory` management panel. Mirrors the
 * `lib/goal/history-filter.ts` pattern — no React, runs inside a `useMemo`.
 *
 * The facet helpers below mirror `lib/issues/board-model.ts`: every option the
 * toolbar offers is derived from the rows actually present, so the menu can
 * never propose a filter that would return nothing.
 */

import type {
  Memory,
  MemoryProvenance,
  MemoryReviewStatus,
  MemoryScope,
  MemoryType,
} from "./types/memory"

export type MemorySortKey = "recent" | "importance" | "accessed" | "created"

export interface MemoryFilter {
  /** Case-insensitive substring over `text` + `tags` + `key`. */
  query?: string
  /** Allowed types; empty/undefined = all. */
  types?: MemoryType[]
  /** Allowed scopes; empty/undefined = all. */
  scopes?: MemoryScope[]
  /** Allowed provenances; empty/undefined = all. */
  provenances?: MemoryProvenance[]
  /** Memory must include EVERY listed tag (AND). Empty/undefined = no tag gate. */
  tags?: string[]
  /**
   * `active` (default) shows only active rows, `invalidated` only archived
   * ones, `all` both. The archived quick view needs "only archived" — before
   * this existed the panel could offer "show archived" but never "show me the
   * archive", which made a soft-delete indistinguishable from a hard one.
   */
  status?: "active" | "invalidated" | "all"
  /** Restrict to `pinned` rows. Undefined/false = no pin gate. */
  pinnedOnly?: boolean
  /**
   * Restrict to one or more review states. An array is an OR — the "needs
   * review" view passes `["unreviewed", "pending_instruction"]`, since
   * ADR-0115 §7 keeps `pending_instruction` rows out of recall until a human
   * promotes them, making them exactly as unreviewed as `unreviewed`.
   */
  reviewStatus?: MemoryReviewStatus | MemoryReviewStatus[]
  sort?: MemorySortKey
}

function matchesQuery(m: Memory, q: string): boolean {
  if (!q) return true
  const needle = q.toLowerCase()
  if (m.text.toLowerCase().includes(needle)) return true
  if (m.key && m.key.toLowerCase().includes(needle)) return true
  return m.tags.some((t) => t.toLowerCase().includes(needle))
}

export function filterAndSortMemories(memories: Memory[], filter: MemoryFilter = {}): Memory[] {
  const query = (filter.query ?? "").trim()
  const status = filter.status ?? "active"
  const allowType = filter.types && filter.types.length > 0 ? new Set(filter.types) : null
  const allowScope = filter.scopes && filter.scopes.length > 0 ? new Set(filter.scopes) : null
  const allowProvenance =
    filter.provenances && filter.provenances.length > 0 ? new Set(filter.provenances) : null
  const requiredTags =
    filter.tags && filter.tags.length > 0 ? filter.tags.map((t) => t.toLowerCase()) : null
  const allowReview = filter.reviewStatus
    ? new Set(Array.isArray(filter.reviewStatus) ? filter.reviewStatus : [filter.reviewStatus])
    : null
  const sort = filter.sort ?? "recent"

  const filtered = memories.filter((m) => {
    if (status === "active" && m.status !== "active") return false
    if (status === "invalidated" && m.status !== "invalidated") return false
    if (filter.pinnedOnly && !m.pinned) return false
    // An unset `reviewStatus` reads as `unreviewed` everywhere else in the
    // subsystem, so the filter has to agree or "needs review" would miss every
    // row written before governance stamping existed.
    if (allowReview && !allowReview.has(m.reviewStatus ?? "unreviewed")) return false
    if (allowType && !allowType.has(m.type)) return false
    if (allowScope && !allowScope.has(m.scope)) return false
    if (allowProvenance && !allowProvenance.has(m.provenance)) return false
    if (requiredTags) {
      const lower = m.tags.map((t) => t.toLowerCase())
      if (!requiredTags.every((t) => lower.includes(t))) return false
    }
    return matchesQuery(m, query)
  })

  const sorted = filtered.slice()
  sorted.sort((a, b) => {
    // Pinned always float to the top regardless of sort key.
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    switch (sort) {
      case "importance":
        return b.importance - a.importance || b.updatedAt - a.updatedAt
      case "accessed":
        return b.lastAccessedAt - a.lastAccessedAt
      case "created":
        return b.createdAt - a.createdAt
      case "recent":
      default:
        return b.updatedAt - a.updatedAt
    }
  })
  return sorted
}

export interface MemoryStats {
  total: number
  active: number
  /** Active + pinned rows (exempt from decay). */
  pinned: number
  /** Active rows stuck in `reviewStatus: "conflict"` (excluded from recall). */
  conflicts: number
  byType: Record<MemoryType, number>
}

export function computeMemoryStats(memories: Memory[]): MemoryStats {
  const byType: Record<MemoryType, number> = { semantic: 0, episodic: 0, procedural: 0 }
  let active = 0
  let pinned = 0
  let conflicts = 0
  for (const m of memories) {
    if (m.status === "active") {
      active++
      byType[m.type]++
      if (m.pinned) pinned++
      if (m.reviewStatus === "conflict") conflicts++
    }
  }
  return { total: memories.length, active, pinned, conflicts, byType }
}

/* -------------------------------------------------------------------------- */
/* Quick views                                                                 */
/* -------------------------------------------------------------------------- */

export type MemoryQuickViewId = "all" | "pinned" | "needsReview" | "conflicts" | "archived"

export interface MemoryQuickView {
  id: MemoryQuickViewId
  /** Key under the `memory.panel.views` namespace — this stays zero-`@/`. */
  labelKey: MemoryQuickViewId
  /**
   * Merged *over* the user's facet selection, so a view always wins on the
   * axes it owns (status / pin / review) and leaves type/scope/tag alone.
   */
  filter: Pick<MemoryFilter, "status" | "pinnedOnly" | "reviewStatus">
}

/**
 * The five states worth one click. These replace the five stat tiles the old
 * panel rendered — those were filters wearing a dashboard's clothes (the
 * "pending review" tile was literally a toggle button), so they are chips now.
 */
export const MEMORY_QUICK_VIEWS: readonly MemoryQuickView[] = [
  { id: "all", labelKey: "all", filter: { status: "active" } },
  { id: "pinned", labelKey: "pinned", filter: { status: "active", pinnedOnly: true } },
  {
    id: "needsReview",
    labelKey: "needsReview",
    filter: { status: "active", reviewStatus: ["unreviewed", "pending_instruction"] },
  },
  {
    id: "conflicts",
    labelKey: "conflicts",
    filter: { status: "active", reviewStatus: "conflict" },
  },
  { id: "archived", labelKey: "archived", filter: { status: "invalidated" } },
] as const

export function findMemoryQuickView(id: MemoryQuickViewId): MemoryQuickView {
  // `all` is the frozen fallback: a persisted or deep-linked id that no longer
  // exists must degrade to "everything", never to an empty list.
  return MEMORY_QUICK_VIEWS.find((v) => v.id === id) ?? MEMORY_QUICK_VIEWS[0]!
}

/** Row count per quick view — the number each chip shows. */
export function countMemoryQuickViews(memories: Memory[]): Record<MemoryQuickViewId, number> {
  const counts = { all: 0, pinned: 0, needsReview: 0, conflicts: 0, archived: 0 }
  for (const m of memories) {
    if (m.status !== "active") {
      counts.archived++
      continue
    }
    counts.all++
    if (m.pinned) counts.pinned++
    const review = m.reviewStatus ?? "unreviewed"
    if (review === "unreviewed" || review === "pending_instruction") counts.needsReview++
    if (review === "conflict") counts.conflicts++
  }
  return counts
}

/* -------------------------------------------------------------------------- */
/* Facets                                                                      */
/* -------------------------------------------------------------------------- */

export interface MemoryFacetOption<T> {
  value: T
  count: number
}

export interface MemoryFacets {
  types: MemoryFacetOption<MemoryType>[]
  scopes: MemoryFacetOption<MemoryScope>[]
  provenances: MemoryFacetOption<MemoryProvenance>[]
  tags: MemoryFacetOption<string>[]
}

function toOptions<T extends string>(counts: Map<T, number>): MemoryFacetOption<T>[] {
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
}

/**
 * Every facet option that would actually match something, with its row count.
 * Pass the rows the quick view already narrowed to — offering a type that the
 * current view does not contain is how "where did my memory go?" happens.
 */
export function collectMemoryFacets(memories: Memory[]): MemoryFacets {
  const types = new Map<MemoryType, number>()
  const scopes = new Map<MemoryScope, number>()
  const provenances = new Map<MemoryProvenance, number>()
  const tags = new Map<string, number>()
  for (const m of memories) {
    types.set(m.type, (types.get(m.type) ?? 0) + 1)
    scopes.set(m.scope, (scopes.get(m.scope) ?? 0) + 1)
    provenances.set(m.provenance, (provenances.get(m.provenance) ?? 0) + 1)
    for (const tag of new Set(m.tags)) tags.set(tag, (tags.get(tag) ?? 0) + 1)
  }
  return {
    types: toOptions(types),
    scopes: toOptions(scopes),
    provenances: toOptions(provenances),
    tags: toOptions(tags),
  }
}

/**
 * How many facet axes the user has narrowed — the number on the Filter menu's
 * badge. The search box and the quick view are visible on their own, so they
 * deliberately do not count here.
 */
export function countActiveMemoryFilters(filter: MemoryFilter): number {
  return (
    (filter.types?.length ?? 0) +
    (filter.scopes?.length ?? 0) +
    (filter.provenances?.length ?? 0) +
    (filter.tags?.length ?? 0)
  )
}

/** Drop every facet selection, keeping the query / sort / view axes. */
export function clearMemoryFacets(filter: MemoryFilter): MemoryFilter {
  const { types: _t, scopes: _s, provenances: _p, tags: _g, ...rest } = filter
  return rest
}
