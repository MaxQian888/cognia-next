"use client"

// Active-filter chips + result count for the Library list.
//
// This strip used to live in the page header's second tier (the
// `PluginSectionToolbar` status line). Every filter change then resized the
// header band and shifted all three panes — including the capability rail
// the user had just clicked, which jumped out from under the cursor. It now
// sits at the top of the list column instead: the rails, the detail pane
// and the page chrome never move, and the strip's arrival is masked by the
// row set it is describing.
//
// Renders nothing visible when nothing is filtered — `empty:hidden` drops
// the bordered strip entirely so the unfiltered library has no dead band.

import { useTranslations } from "next-intl"
import { usePlugins } from "@/hooks/plugins"
import { PluginActiveFilters } from "./plugin-active-filters"

export function PluginLibraryStatusBar() {
  const t = useTranslations("plugins.panel")
  const { filtered, totals, loading } = usePlugins()
  // Only surface the count when the visible set is narrower than the total
  // (or when a search query is active). Hides on the unfiltered "All" view
  // so the strip stays gone when there's nothing to communicate.
  const showCount = !loading && totals.total > 0 && filtered.length !== totals.total

  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-1.5 empty:hidden"
      data-testid="plugin-library-status-bar"
    >
      <PluginActiveFilters />
      {showCount ? (
        <p
          className="ml-auto text-xs text-muted-foreground"
          role="status"
          aria-live="polite"
          data-testid="plugin-library-result-count"
        >
          {filtered.length === 0
            ? t("resultsCountEmpty", { total: totals.total })
            : t("resultsCount", { count: filtered.length, total: totals.total })}
        </p>
      ) : null}
    </div>
  )
}
