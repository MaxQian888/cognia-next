"use client"

/**
 * The `/memory` filter facets as data: one entry per axis with its label, the
 * options the current view actually contains, what is selected and how to
 * toggle it. The desktop Filter menu and the compact filter drawer render the
 * same list with different primitives, so an axis added here appears in both.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"

import type { MemoryFacets, MemoryFilter } from "@/lib/memory/history-filter"

const MAX_TAG_OPTIONS = 12
const MAX_BRANCH_OPTIONS = 12

export interface MemoryFacetGroup {
  key: string
  label: string
  options: readonly { value: string; count: number }[]
  selected: readonly string[] | undefined
  render: (value: string) => string
  toggle: (value: string) => void
}

/** Toggle a value in a readonly facet array without mutating it. */
function toggled<T>(values: readonly T[] | undefined, value: T): T[] {
  const current = values ?? []
  return current.includes(value) ? current.filter((v) => v !== value) : [...current, value]
}

export function useMemoryFacetGroups({
  facets,
  filter,
  onFilterChange,
  projectNames,
}: {
  facets: MemoryFacets
  filter: MemoryFilter
  onFilterChange: (filter: MemoryFilter) => void
  projectNames?: Record<string, string>
}): MemoryFacetGroup[] {
  const t = useTranslations("memory.panel")
  const tTypes = useTranslations("memory.types")
  const tScopes = useTranslations("memory.scopes")
  const tProv = useTranslations("memory.provenance")
  const tKind = useTranslations("memory.projectKind")
  const tFresh = useTranslations("memory.freshness")

  return useMemo(() => {
    // Each axis is typed by its own facet; the group list is the common,
    // string-keyed view of them, which is all a renderer needs.
    const axis = <K extends keyof MemoryFilter>(
      key: K,
      label: string,
      options: readonly { value: string; count: number }[],
      render: (value: string) => string
    ): MemoryFacetGroup => ({
      key,
      label,
      options,
      selected: filter[key] as readonly string[] | undefined,
      render,
      toggle: (value) =>
        onFilterChange({
          ...filter,
          [key]: toggled(filter[key] as readonly string[] | undefined, value),
        }),
    })
    return [
      axis("types", t("filter.types"), facets.types, (v) => tTypes(v as never)),
      axis("scopes", t("filter.scopes"), facets.scopes, (v) => tScopes(v as never)),
      axis("provenances", t("filter.provenances"), facets.provenances, (v) => tProv(v as never)),
      axis("tags", t("filter.tags"), facets.tags.slice(0, MAX_TAG_OPTIONS), (v) => v),
      // The corpus partition, as one axis. `personal` is the ABSENCE of a
      // `projectMemoryKind`, resolved by the same predicate the retriever
      // partitions on, so the console can never disagree with what was recalled.
      axis("projectMemoryKinds", t("filter.projectMemoryKinds"), facets.projectMemoryKinds, (v) =>
        tKind(v as never)
      ),
      // The unscoped row gets a name rather than an empty option — "no
      // workspace" is a real answer to "which workspace", not a gap.
      axis(
        "projectIds",
        t("filter.projectIds"),
        facets.projectIds,
        (v) => projectNames?.[v] || v || t("filter.noWorkspace")
      ),
      axis(
        "branches",
        t("filter.branches"),
        facets.branches.slice(0, MAX_BRANCH_OPTIONS),
        (v) => v
      ),
      axis("freshness", t("filter.freshness"), facets.freshness, (v) => tFresh(v as never)),
    ]
  }, [facets, filter, onFilterChange, projectNames, t, tTypes, tScopes, tProv, tKind, tFresh])
}
