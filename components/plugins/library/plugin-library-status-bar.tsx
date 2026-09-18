"use client"

// Active-filter chips + result count for the Library list.
//
// This strip used to live in the page header's second tier — appearing
// there resized the header band and shifted all three panes, including the
// capability rail the user had just clicked, which jumped out from under
// the cursor. It now sits at the top of the list column instead: the
// rails, the detail pane and the page chrome never move, and the strip's
// arrival is masked by the row set it is describing.
//
// Two rules keep it from reintroducing that shift inside the column:
//   - it returns null when nothing is filtered, so the unfiltered library
//     has no dead band;
//   - it is one line that scrolls horizontally rather than wrapping, so a
//     growing chip set can never grow the band's height and push the rows.

import { useTranslations } from "next-intl"
import { usePlugins } from "@/hooks/plugins"
import { PluginActiveFilters, useHasActivePluginFilters } from "./plugin-active-filters"

export function PluginLibraryStatusBar() {
  const t = useTranslations("plugins.panel")
  const { filtered, totals, loading } = usePlugins()
  const hasFilters = useHasActivePluginFilters()
  // Only surface the count when the visible set is narrower than the total.
  const showCount = !loading && totals.total > 0 && filtered.length !== totals.total

  if (!hasFilters && !showCount) return null

  return (
    <div
      className="flex shrink-0 items-center gap-x-3 overflow-x-auto border-b px-3 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      data-testid="plugin-library-status-bar"
    >
      <PluginActiveFilters />
      {showCount ? (
        <p
          className="shrink-0 text-xs text-muted-foreground"
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
