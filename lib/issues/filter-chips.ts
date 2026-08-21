/**
 * Active-filter chips for the issue surface.
 *
 * The toolbar used to signal an engaged filter with nothing but a count badge
 * on a closed menu, which is how "where did my issue go?" happens: the board
 * silently shows a subset and the only evidence is a number the user has to
 * open a dropdown to decode. Chips make each engaged facet visible and
 * individually removable.
 *
 * Pure, and free of i18n: the chips carry a facet and a raw value, and the
 * component localizes them (a label name, a project name, an actor's cached
 * display name). Same split as the rest of `board-model` — decisions here,
 * strings there.
 */

import type { IssuePriority } from "@/types/issues"
import type { IssueSourceKind } from "@/types/issues/unified"
import { EMPTY_ISSUE_FILTER, type IssueBoardFilter } from "./board-model"

export type IssueFilterFacet = keyof IssueBoardFilter

export interface IssueFilterChip {
  facet: IssueFilterFacet
  /**
   * The single value this chip stands for. The free-text query has no
   * enumerable values, so it carries the query text itself and removing the
   * chip clears the whole facet.
   */
  value: string
  /** Stable React key — a facet's values are unique within that facet. */
  key: string
}

function chip(facet: IssueFilterFacet, value: string): IssueFilterChip {
  return { facet, value, key: `${facet}:${value}` }
}

/**
 * One chip per engaged filter value, in the order the filter menu lists the
 * facets so the chip row and the menu read the same way.
 */
export function collectActiveFilterChips(filter: IssueBoardFilter): IssueFilterChip[] {
  const chips: IssueFilterChip[] = []
  const query = filter.query.trim()
  if (query) chips.push(chip("query", query))
  for (const priority of filter.priorities) chips.push(chip("priorities", priority))
  for (const labelId of filter.labelIds) chips.push(chip("labelIds", labelId))
  for (const assignee of filter.assignees) chips.push(chip("assignees", assignee))
  for (const source of filter.sources) chips.push(chip("sources", source))
  for (const projectId of filter.issueProjectIds) chips.push(chip("issueProjectIds", projectId))
  return chips
}

/** Remove one chip's value, leaving every other facet untouched. */
export function removeFilterChip(
  filter: IssueBoardFilter,
  chipToRemove: IssueFilterChip
): IssueBoardFilter {
  switch (chipToRemove.facet) {
    case "query":
      return { ...filter, query: "" }
    case "priorities":
      return {
        ...filter,
        priorities: filter.priorities.filter((value) => value !== chipToRemove.value),
      }
    case "labelIds":
      return { ...filter, labelIds: filter.labelIds.filter((v) => v !== chipToRemove.value) }
    case "assignees":
      return { ...filter, assignees: filter.assignees.filter((v) => v !== chipToRemove.value) }
    case "sources":
      return { ...filter, sources: filter.sources.filter((v) => v !== chipToRemove.value) }
    case "issueProjectIds":
      return {
        ...filter,
        issueProjectIds: filter.issueProjectIds.filter((v) => v !== chipToRemove.value),
      }
  }
}

/** Toggle one value of a multi-select facet. Used by the rail and the menu alike. */
export function toggleFilterValue(
  filter: IssueBoardFilter,
  facet: "labelIds" | "priorities" | "assignees" | "sources" | "issueProjectIds",
  value: string
): IssueBoardFilter {
  const current = filter[facet] as readonly string[]
  const next = current.includes(value)
    ? current.filter((candidate) => candidate !== value)
    : [...current, value]
  // The cast narrows back to the facet's own element type; every facet is a
  // readonly array of strings at runtime and the callers are type-checked.
  return { ...filter, [facet]: next } as IssueBoardFilter
}

/**
 * Replace one facet outright, clearing everything else in it. The rail's
 * project rows use this: clicking a project means "show me this project",
 * not "add this project to whatever I had".
 */
export function setSoleFilterValue(
  filter: IssueBoardFilter,
  facet: "issueProjectIds",
  value: string | null
): IssueBoardFilter {
  return { ...filter, [facet]: value === null ? [] : [value] }
}

/** Typed re-export so callers do not have to reach into board-model for it. */
export const CLEARED_ISSUE_FILTER: IssueBoardFilter = EMPTY_ISSUE_FILTER

export type { IssuePriority, IssueSourceKind }
