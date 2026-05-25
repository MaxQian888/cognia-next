// Pure filter + sort helpers for the workflow library entry page (ADR-0011
// library upgrade). Kept side-effect free so the orchestrator can run them in
// a single `useMemo` and so they're unit-testable without Dexie or React.

import type { WorkflowRow } from "@/types/workflow/visual"
import type { WorkflowLibraryFilters, WorkflowSortMode } from "@/stores/workflow"

/** Case-insensitive match on name, description, or any tag. Empty query passes. */
export function matchesQuery(w: WorkflowRow, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return (
    w.name.toLowerCase().includes(needle) ||
    (w.description?.toLowerCase().includes(needle) ?? false) ||
    (w.tags?.some((t) => t.toLowerCase().includes(needle)) ?? false)
  )
}

/** True when the workflow contains at least one trigger node. */
export function hasTriggerNode(w: WorkflowRow): boolean {
  return w.nodes.some((n) => n.type.startsWith("trigger."))
}

export interface FilterContext {
  query: string
  filters: WorkflowLibraryFilters
  /** Ids of workflows that failed recently (only consulted when the filter is on). */
  recentlyFailedIds: Set<string>
}

export function filterWorkflows(rows: WorkflowRow[], ctx: FilterContext): WorkflowRow[] {
  return rows.filter((w) => {
    if (!matchesQuery(w, ctx.query)) return false
    switch (ctx.filters.type) {
      case "user":
        if (w.isTemplate || w.isBuiltIn) return false
        break
      case "template":
        if (!w.isTemplate) return false
        break
      case "builtin":
        if (!w.isBuiltIn) return false
        break
      case "all":
      default:
        break
    }
    if (ctx.filters.hasTrigger && !hasTriggerNode(w)) return false
    if (ctx.filters.recentlyFailed && !ctx.recentlyFailedIds.has(w.id)) return false
    return true
  })
}

/** Returns a new sorted array; never mutates the input. */
export function sortWorkflows(
  rows: WorkflowRow[],
  sort: WorkflowSortMode,
  runCounts: Map<string, number>
): WorkflowRow[] {
  const copy = [...rows]
  switch (sort) {
    case "nameAsc":
      copy.sort((a, b) => a.name.localeCompare(b.name))
      break
    case "nameDesc":
      copy.sort((a, b) => b.name.localeCompare(a.name))
      break
    case "updated":
      copy.sort((a, b) => b.updatedAt - a.updatedAt)
      break
    case "created":
      copy.sort((a, b) => b.createdAt - a.createdAt)
      break
    case "runCount":
      copy.sort((a, b) => (runCounts.get(b.id) ?? 0) - (runCounts.get(a.id) ?? 0))
      break
  }
  return copy
}

/**
 * Resolve which workflow ids a drag-and-drop move applies to: the entire
 * current selection when the dragged item is part of it, otherwise just the
 * dragged item.
 */
export function resolveDragMoveIds(draggedId: string, selection: Set<string>): string[] {
  return selection.has(draggedId) ? Array.from(selection) : [draggedId]
}

/** Whether any non-default filter or a non-empty query is active. */
export function isFilterActive(query: string, filters: WorkflowLibraryFilters): boolean {
  return (
    query.trim().length > 0 ||
    filters.type !== "all" ||
    filters.hasTrigger ||
    filters.recentlyFailed
  )
}
