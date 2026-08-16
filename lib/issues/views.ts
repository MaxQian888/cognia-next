/**
 * Issue views — the `All / Assigned / Created / My Agents and Squads` tabs.
 *
 * These four are built-in and hard-coded, BUT they are expressed in the exact
 * shape a user-saved view would take (`{ id, labelKey, scope, filter, sort,
 * groupBy, layout, builtin }`). This repo has no saved-views system anywhere
 * today; when one is added, "save current filter" becomes "write a row with
 * `builtin: false`" and nothing in the rendering layer changes.
 *
 * Two of the four tabs ("Assigned", "Created") and one more ("My Agents and
 * Squads") cannot be expressed as a static filter — they depend on who is
 * looking. That is what `IssueViewScope` is for: a discriminator resolved
 * against an `IssueViewerContext` at query time. A user-saved view simply
 * carries `scope: "all"` plus a concrete filter.
 */

import type { UnifiedIssueItem } from "@/types/issues/unified"
import {
  actorKey,
  EMPTY_ISSUE_FILTER,
  type IssueBoardFilter,
  type IssueGroupBy,
} from "./board-model"
import { priorityRank } from "@/types/issues"

/** Dynamic membership rule, resolved against the viewer. */
export type IssueViewScope = "all" | "assigned-to-me" | "created-by-me" | "my-agents"

export const ISSUE_SORT_MODES = ["manual", "priority", "updated", "created", "title"] as const

export type IssueSortMode = (typeof ISSUE_SORT_MODES)[number]

export type IssueViewLayout = "board" | "list"

export interface IssueViewDefinition {
  id: string
  /** i18n key under `issues.views.*`. */
  labelKey: string
  scope: IssueViewScope
  filter: IssueBoardFilter
  sort: IssueSortMode
  groupBy: IssueGroupBy
  layout: IssueViewLayout
  /** Built-ins cannot be edited or deleted. */
  builtin: boolean
}

/** Who is looking. Built from the account + the agent/team rosters. */
export interface IssueViewerContext {
  /** `actorKey` for the local human, i.e. `"human:self"`. */
  selfKey: string
  /** `actorKey`s of every agent and team the viewer owns. */
  agentKeys: readonly string[]
}

/**
 * The four tabs, in display order. Kept as a frozen constant so a stale
 * reference can never mutate another consumer's copy.
 */
export const BUILTIN_ISSUE_VIEWS: readonly IssueViewDefinition[] = Object.freeze([
  Object.freeze({
    id: "all",
    labelKey: "all",
    scope: "all" as const,
    filter: EMPTY_ISSUE_FILTER,
    sort: "manual" as const,
    groupBy: "status" as const,
    layout: "board" as const,
    builtin: true,
  }),
  Object.freeze({
    id: "assigned",
    labelKey: "assigned",
    scope: "assigned-to-me" as const,
    filter: EMPTY_ISSUE_FILTER,
    sort: "priority" as const,
    groupBy: "status" as const,
    layout: "board" as const,
    builtin: true,
  }),
  Object.freeze({
    id: "created",
    labelKey: "created",
    scope: "created-by-me" as const,
    filter: EMPTY_ISSUE_FILTER,
    sort: "created" as const,
    groupBy: "status" as const,
    layout: "list" as const,
    builtin: true,
  }),
  Object.freeze({
    id: "my-agents",
    labelKey: "myAgents",
    scope: "my-agents" as const,
    filter: EMPTY_ISSUE_FILTER,
    sort: "updated" as const,
    groupBy: "assignee" as const,
    layout: "board" as const,
    builtin: true,
  }),
]) as readonly IssueViewDefinition[]

export const DEFAULT_ISSUE_VIEW_ID = "all"

export function findIssueView(id: string): IssueViewDefinition | undefined {
  return BUILTIN_ISSUE_VIEWS.find((view) => view.id === id)
}

/** Does this item belong to the view's dynamic scope? */
export function matchesViewScope(
  item: UnifiedIssueItem,
  scope: IssueViewScope,
  viewer: IssueViewerContext
): boolean {
  switch (scope) {
    case "all":
      return true
    case "assigned-to-me":
      return actorKey(item.assignee) === viewer.selfKey
    case "created-by-me":
      return actorKey(item.createdBy) === viewer.selfKey
    case "my-agents": {
      const key = actorKey(item.assignee)
      return key !== null && viewer.agentKeys.includes(key)
    }
  }
}

export function applyViewScope(
  items: readonly UnifiedIssueItem[],
  scope: IssueViewScope,
  viewer: IssueViewerContext
): UnifiedIssueItem[] {
  if (scope === "all") return [...items]
  return items.filter((item) => matchesViewScope(item, scope, viewer))
}

/**
 * Sort a flat list. `manual` is a no-op here — manual order is applied per
 * column by `sortIssueColumn`, because dragging is only meaningful within a
 * column and a global manual order across columns has no user-visible meaning.
 */
export function applyIssueSort(
  items: readonly UnifiedIssueItem[],
  sort: IssueSortMode
): UnifiedIssueItem[] {
  const sorted = [...items]
  switch (sort) {
    case "manual":
      return sorted
    case "priority":
      return sorted.sort(
        (a, b) => priorityRank(a.priority) - priorityRank(b.priority) || b.updatedAt - a.updatedAt
      )
    case "updated":
      return sorted.sort((a, b) => b.updatedAt - a.updatedAt)
    case "created":
      return sorted.sort((a, b) => b.createdAt - a.createdAt)
    case "title":
      return sorted.sort((a, b) => a.title.localeCompare(b.title))
  }
}
