"use client"

// Empty-state panel for the workflow library, covering the three distinct
// "nothing to show" cases: an empty library root, an empty folder, and a
// search/filter that matched nothing. Built on the shared `Empty` primitive.
//
// The filtered case names what is doing the hiding. A search query that
// matches nothing looks exactly like an empty library unless the panel says
// so, and the clear action resets the search together with the facets — a
// "Clear filters" that left the query in place kept the list empty.

import { useTranslations } from "next-intl"
import { PlusIcon, WorkflowIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"

export type WorkflowLibraryEmptyVariant = "root" | "folder" | "filtered"

/** Longest search text quoted back in the title before it is elided. */
const MAX_QUOTED_QUERY_CHARS = 60

export interface WorkflowLibraryEmptyProps {
  variant: WorkflowLibraryEmptyVariant
  onCreate?: () => void
  /** Clears the search text AND the facet filters. */
  onClearFilters?: () => void
  /** Current search text; when non-blank the filtered copy says the search is what hides rows. */
  query?: string
  /** Number of non-default facet filters (type / has-trigger / recently-failed). */
  activeFilterCount?: number
}

export function WorkflowLibraryEmpty({
  variant,
  onCreate,
  onClearFilters,
  query = "",
  activeFilterCount = 0,
}: WorkflowLibraryEmptyProps) {
  const t = useTranslations("workflows.library.empty")

  const trimmedQuery = query.trim()
  const searchActive = variant === "filtered" && trimmedQuery.length > 0
  const quotedQuery =
    trimmedQuery.length > MAX_QUOTED_QUERY_CHARS
      ? `${trimmedQuery.slice(0, MAX_QUOTED_QUERY_CHARS)}…`
      : trimmedQuery

  const copy = searchActive
    ? {
        title: t("searchTitle", { query: quotedQuery }),
        description:
          activeFilterCount > 0
            ? t("searchAndFilterDescription", { count: activeFilterCount })
            : t("searchDescription"),
        clear: activeFilterCount > 0 ? t("clearSearchAndFilters") : t("clearSearch"),
      }
    : variant === "filtered"
      ? { title: t("filterTitle"), description: t("filterDescription"), clear: t("clearFilters") }
      : variant === "folder"
        ? { title: t("folderTitle"), description: t("folderDescription"), clear: null }
        : { title: t("title"), description: t("description"), clear: null }

  return (
    <Empty
      className="mx-auto max-w-md py-12"
      data-testid={`workflow-empty-${variant}`}
      data-search-active={searchActive ? "true" : undefined}
    >
      <EmptyHeader>
        <EmptyMedia>
          <WorkflowIcon className="size-8" aria-hidden="true" />
        </EmptyMedia>
      </EmptyHeader>
      <EmptyTitle className="break-words">{copy.title}</EmptyTitle>
      <EmptyDescription>{copy.description}</EmptyDescription>
      {variant === "filtered" ? (
        <Button
          variant="outline"
          className="mt-2"
          onClick={onClearFilters}
          data-testid="workflow-empty-clear"
        >
          {copy.clear}
        </Button>
      ) : (
        <Button className="mt-2" onClick={onCreate}>
          <PlusIcon className="size-4 mr-1.5" />
          {t("cta")}
        </Button>
      )}
    </Empty>
  )
}
