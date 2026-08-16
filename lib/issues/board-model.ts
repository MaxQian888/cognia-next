/**
 * Pure derivations for the issue board — columns, swimlanes, grouping,
 * filters, run hints, and the dnd drop reducer.
 *
 * All board decision logic lives here (testable without React/dnd-kit); the
 * components in `components/issues/board/` stay thin render shells. This is
 * the same split `lib/ai/agent/team/board-model.ts` uses, and it is the reason
 * that board's rules are exhaustively unit-tested while its React layer is
 * mostly markup. Do not leak decisions upward into the components.
 *
 * Everything here operates on `UnifiedIssueItem`, never on raw `Issue` rows,
 * so federated (read-only) rows flow through the exact same code path as local
 * ones and cannot accidentally acquire write affordances.
 */

import type { IssuePriority, IssueActor, IssueStatus } from "@/types/issues"
import { ISSUE_STATUSES, priorityRank } from "@/types/issues"
import type { IssueSourceKind, UnifiedIssueItem } from "@/types/issues/unified"
import { compareUnifiedIssues } from "@/types/issues/unified"
import { canMoveIssue, type IssueMoveContext, type IssueMoveDenial } from "./state-machine"

/** Canonical column order — mirrors the issue lifecycle left to right. */
export const ISSUE_BOARD_COLUMN_ORDER: readonly IssueStatus[] = ISSUE_STATUSES

/**
 * Stable key for a polymorphic actor, used for grouping and filtering.
 * The local human carries no id, so it collapses to a single well-known key.
 */
export function actorKey(actor: IssueActor | undefined): string | null {
  if (!actor) return null
  return `${actor.kind}:${actor.id ?? "self"}`
}

// ── filtering ───────────────────────────────────────────────────────────────

export interface IssueBoardFilter {
  /** Free-text match against identifier, title and description. */
  query: string
  /** Keep issues carrying at least one of these labels (empty = all). */
  labelIds: readonly string[]
  /** Keep issues with one of these priorities (empty = all). */
  priorities: readonly IssuePriority[]
  /** Keep issues assigned to one of these `actorKey`s (empty = all). */
  assignees: readonly string[]
  /** Keep issues from one of these federated sources (empty = all). */
  sources: readonly IssueSourceKind[]
  /** Keep issues in one of these delivery containers (empty = all). */
  issueProjectIds: readonly string[]
}

export const EMPTY_ISSUE_FILTER: IssueBoardFilter = Object.freeze({
  query: "",
  labelIds: [],
  priorities: [],
  assignees: [],
  sources: [],
  issueProjectIds: [],
})

export function isIssueFilterActive(filter: IssueBoardFilter): boolean {
  return (
    filter.query.trim().length > 0 ||
    filter.labelIds.length > 0 ||
    filter.priorities.length > 0 ||
    filter.assignees.length > 0 ||
    filter.sources.length > 0 ||
    filter.issueProjectIds.length > 0
  )
}

/** Count of engaged facets, for the toolbar's badge. Query counts as one. */
export function countActiveIssueFilters(filter: IssueBoardFilter): number {
  let count = 0
  if (filter.query.trim().length > 0) count += 1
  if (filter.labelIds.length > 0) count += 1
  if (filter.priorities.length > 0) count += 1
  if (filter.assignees.length > 0) count += 1
  if (filter.sources.length > 0) count += 1
  if (filter.issueProjectIds.length > 0) count += 1
  return count
}

function matchesQuery(item: UnifiedIssueItem, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return (
    item.identifier.toLowerCase().includes(needle) ||
    item.title.toLowerCase().includes(needle) ||
    (item.description?.toLowerCase().includes(needle) ?? false)
  )
}

export function applyIssueFilter(
  items: readonly UnifiedIssueItem[],
  filter: IssueBoardFilter
): UnifiedIssueItem[] {
  if (!isIssueFilterActive(filter)) return [...items]
  return items.filter((item) => {
    if (!matchesQuery(item, filter.query)) return false
    if (filter.labelIds.length > 0 && !item.labelIds.some((id) => filter.labelIds.includes(id))) {
      return false
    }
    if (filter.priorities.length > 0 && !filter.priorities.includes(item.priority)) return false
    if (filter.sources.length > 0 && !filter.sources.includes(item.kind)) return false
    if (filter.issueProjectIds.length > 0) {
      if (!item.issueProjectId || !filter.issueProjectIds.includes(item.issueProjectId)) {
        return false
      }
    }
    if (filter.assignees.length > 0) {
      const key = actorKey(item.assignee)
      if (!key || !filter.assignees.includes(key)) return false
    }
    return true
  })
}

/** Distinct facet values present in the current item set, for the filter menu. */
export function collectIssueFilterOptions(items: readonly UnifiedIssueItem[]): {
  labelIds: string[]
  assignees: Array<{ key: string; actor: IssueActor }>
  sources: IssueSourceKind[]
  issueProjectIds: string[]
} {
  const labelIds = new Set<string>()
  const assignees = new Map<string, IssueActor>()
  const sources = new Set<IssueSourceKind>()
  const issueProjectIds = new Set<string>()

  for (const item of items) {
    for (const labelId of item.labelIds) labelIds.add(labelId)
    const key = actorKey(item.assignee)
    if (key && item.assignee && !assignees.has(key)) assignees.set(key, item.assignee)
    sources.add(item.kind)
    if (item.issueProjectId) issueProjectIds.add(item.issueProjectId)
  }

  return {
    labelIds: [...labelIds].sort(),
    assignees: [...assignees.entries()]
      .map(([key, actor]) => ({ key, actor }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    sources: [...sources].sort(),
    issueProjectIds: [...issueProjectIds].sort(),
  }
}

// ── columns & lanes ─────────────────────────────────────────────────────────

/** Stable visual order within a column. */
export function sortIssueColumn(items: readonly UnifiedIssueItem[]): UnifiedIssueItem[] {
  return [...items].sort(compareUnifiedIssues)
}

export interface IssueBoardColumn {
  status: IssueStatus
  items: UnifiedIssueItem[]
}

/** All six columns in canonical order, each sorted for stable display. */
export function buildIssueColumns(items: readonly UnifiedIssueItem[]): IssueBoardColumn[] {
  return ISSUE_BOARD_COLUMN_ORDER.map((status) => ({
    status,
    items: sortIssueColumn(items.filter((item) => item.status === status)),
  }))
}

export interface IssueSwimlane {
  /** `actorKey` of the lane owner, or null for the unassigned lane. */
  assigneeKey: string | null
  actor?: IssueActor
  columns: IssueBoardColumn[]
  itemCount: number
}

/**
 * Group items into per-assignee lanes. Assigned lanes come first, ordered by
 * key for determinism; an unassigned lane is appended when anything has no
 * owner. Empty lanes are dropped.
 */
export function buildIssueSwimlanes(items: readonly UnifiedIssueItem[]): IssueSwimlane[] {
  const byOwner = new Map<string | null, UnifiedIssueItem[]>()
  const actorByKey = new Map<string, IssueActor>()

  for (const item of items) {
    const key = actorKey(item.assignee)
    if (key && item.assignee && !actorByKey.has(key)) actorByKey.set(key, item.assignee)
    const bucket = byOwner.get(key) ?? []
    bucket.push(item)
    byOwner.set(key, bucket)
  }

  const lanes: IssueSwimlane[] = []
  const assignedKeys = [...byOwner.keys()].filter((k): k is string => k !== null).sort()

  for (const key of assignedKeys) {
    const laneItems = byOwner.get(key)
    if (!laneItems || laneItems.length === 0) continue
    const actor = actorByKey.get(key)
    lanes.push({
      assigneeKey: key,
      ...(actor ? { actor } : {}),
      columns: buildIssueColumns(laneItems),
      itemCount: laneItems.length,
    })
  }

  const unassigned = byOwner.get(null)
  if (unassigned && unassigned.length > 0) {
    lanes.push({
      assigneeKey: null,
      columns: buildIssueColumns(unassigned),
      itemCount: unassigned.length,
    })
  }

  return lanes
}

// ── list grouping (Display menu) ────────────────────────────────────────────

export const ISSUE_GROUP_BY_OPTIONS = ["status", "assignee", "priority", "project", "none"] as const

export type IssueGroupBy = (typeof ISSUE_GROUP_BY_OPTIONS)[number]

export interface IssueGroup {
  /** Stable group key. `""` is the catch-all ("no assignee", "no project"). */
  key: string
  items: UnifiedIssueItem[]
}

/**
 * Group the list view. Groups come back in a meaningful order per axis
 * (lifecycle order for status, urgency order for priority, alphabetical
 * otherwise) with the catch-all group last. The caller localizes the labels.
 */
export function buildIssueGroups(
  items: readonly UnifiedIssueItem[],
  groupBy: IssueGroupBy
): IssueGroup[] {
  if (groupBy === "none") {
    return [{ key: "", items: sortIssueColumn(items) }]
  }

  const buckets = new Map<string, UnifiedIssueItem[]>()
  const push = (key: string, item: UnifiedIssueItem) => {
    const bucket = buckets.get(key) ?? []
    bucket.push(item)
    buckets.set(key, bucket)
  }

  for (const item of items) {
    switch (groupBy) {
      case "status":
        push(item.status, item)
        break
      case "assignee":
        push(actorKey(item.assignee) ?? "", item)
        break
      case "priority":
        push(item.priority, item)
        break
      case "project":
        push(item.issueProjectId ?? "", item)
        break
    }
  }

  const order = (key: string): number => {
    if (key === "") return Number.POSITIVE_INFINITY // catch-all always last
    if (groupBy === "status") return ISSUE_BOARD_COLUMN_ORDER.indexOf(key as IssueStatus)
    if (groupBy === "priority") return priorityRank(key as IssuePriority)
    return 0
  }

  return [...buckets.entries()]
    .map(([key, groupItems]) => ({ key, items: sortIssueColumn(groupItems) }))
    .sort((a, b) => order(a.key) - order(b.key) || a.key.localeCompare(b.key))
}

// ── run hint ────────────────────────────────────────────────────────────────

export interface IssueRunHint {
  /** Issues with a run currently in flight — the "N agents working" pill. */
  running: number
  /** Issues sitting in `in_review` awaiting a human verdict. */
  awaitingReview: number
}

export function issueRunHint(
  items: readonly UnifiedIssueItem[],
  runningIds: ReadonlySet<string>
): IssueRunHint {
  let running = 0
  let awaitingReview = 0
  for (const item of items) {
    if (runningIds.has(item.unifiedId)) running += 1
    if (item.status === "in_review") awaitingReview += 1
  }
  return { running, awaitingReview }
}

// ── dnd drop reducer ────────────────────────────────────────────────────────

/** Droppable id for a column. */
export const columnDropId = (status: IssueStatus): string => `col:${status}`

/** Parse a droppable/sortable id back into its meaning. */
export function parseDndId(
  id: string
): { kind: "column"; status: IssueStatus } | { kind: "card"; unifiedId: string } {
  if (id.startsWith("col:")) return { kind: "column", status: id.slice(4) as IssueStatus }
  return { kind: "card", unifiedId: id }
}

export type IssueDropAction =
  | { type: "move"; unifiedId: string; to: IssueStatus }
  | { type: "reorder"; unifiedId: string; targetIndex: number }
  | { type: "denied"; unifiedId: string; reason: IssueMoveDenial }

/**
 * Resolve a dnd-kit drag-end into a board action, or null for a no-op.
 * Dropping on a card in the same column → reorder to that card's index;
 * dropping on another column (or a card inside it) → guarded move.
 */
export function resolveIssueDrop(
  activeId: string | null,
  overId: string | null,
  itemsById: ReadonlyMap<string, UnifiedIssueItem>,
  context: IssueMoveContext
): IssueDropAction | null {
  if (!activeId || !overId || activeId === overId) return null
  const active = parseDndId(activeId)
  if (active.kind !== "card") return null
  const item = itemsById.get(active.unifiedId)
  if (!item) return null

  const over = parseDndId(overId)
  const targetStatus =
    over.kind === "column" ? over.status : (itemsById.get(over.unifiedId)?.status ?? null)
  if (!targetStatus) return null

  if (targetStatus === item.status) {
    if (over.kind === "column") return null // dropped back on its own column
    if (!item.capabilities.canMove) {
      return { type: "denied", unifiedId: item.unifiedId, reason: "federated-read-only" }
    }
    const column = sortIssueColumn(
      [...itemsById.values()].filter((candidate) => candidate.status === item.status)
    )
    const targetIndex = column.findIndex((candidate) => candidate.unifiedId === over.unifiedId)
    if (targetIndex === -1) return null
    return { type: "reorder", unifiedId: item.unifiedId, targetIndex }
  }

  const verdict = canMoveIssue(item.capabilities, item.status, targetStatus, context)
  if (!verdict.allowed) {
    return { type: "denied", unifiedId: item.unifiedId, reason: verdict.reason }
  }
  return { type: "move", unifiedId: item.unifiedId, to: targetStatus }
}

/**
 * Pure same-column reorder. Renumbers `order` 0..n-1 across the column's
 * visual sequence but returns changes only for LOCAL rows — federated rows
 * have no writable `order`, so their positions are recomputed on every render
 * from their own source and must not be persisted here.
 *
 * Returns `sourceId`s (not `unifiedId`s) because the caller writes to Dexie.
 */
export function reorderIssueColumn(
  column: readonly UnifiedIssueItem[],
  unifiedId: string,
  targetIndex: number
): Array<{ sourceId: string; order: number }> {
  const fromIndex = column.findIndex((item) => item.unifiedId === unifiedId)
  if (fromIndex === -1) return []
  const clamped = Math.max(0, Math.min(targetIndex, column.length - 1))

  const sequence = [...column]
  const [moved] = sequence.splice(fromIndex, 1)
  sequence.splice(clamped, 0, moved)

  const changes: Array<{ sourceId: string; order: number }> = []
  sequence.forEach((item, index) => {
    if (item.kind !== "local") return
    if (item.order !== index) changes.push({ sourceId: item.sourceId, order: index })
  })
  return changes
}
