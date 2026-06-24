"use client"

/**
 * A2UI Search Results Adapter
 * Bridges A2UIComponentProps to AcademicSearchResults via the withA2UIContext
 * HOC — the search-results sibling of A2UIAnalysisAdapter. Reads the paper list
 * and query state from the A2UI data model and forwards user interactions back
 * as A2UI actions.
 */

import type { A2UIComponentProps } from "@/types/a2ui/schema"
import type { Paper } from "@/types/academic"
import { AcademicSearchResults, type SearchFilters } from "./academic-search-results"

export function A2UISearchResultsAdapter({
  component: _component,
  dataModel,
  onAction,
  onDataChange,
}: A2UIComponentProps) {
  const papers = (dataModel?.papers as Paper[]) || []
  const query = (dataModel?.query as string) || ""
  const totalResults = (dataModel?.totalResults as number) ?? papers.length
  const isLoading = (dataModel?.isLoading as boolean) || false
  const hasMore = (dataModel?.hasMore as boolean) || false
  const providerResults = dataModel?.providerResults as
    | Record<string, { count: number; success: boolean }>
    | undefined

  return (
    <AcademicSearchResults
      papers={papers}
      query={query}
      totalResults={totalResults}
      isLoading={isLoading}
      hasMore={hasMore}
      providerResults={providerResults}
      onPaperSelect={(paper) => onAction?.("paperSelect", { id: paper.id })}
      onAddToLibrary={(paper) => onAction?.("addToLibrary", { id: paper.id })}
      onAnalyzePaper={(paper) => onAction?.("analyzePaper", { id: paper.id })}
      onLoadMore={() => onAction?.("loadMore", {})}
      onFilterChange={(filters: SearchFilters) => {
        onDataChange?.("filters", filters as unknown as Record<string, unknown>)
        onAction?.("filterChange", filters as unknown as Record<string, unknown>)
      }}
    />
  )
}
