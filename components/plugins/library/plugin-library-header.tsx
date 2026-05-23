"use client"

// Sticky header for the Library middle pane. Composes:
//
//   - Search input (reuses store.filters.query, like the legacy panel header)
//   - Library sub-filter chips (All / Enabled / Updates / Configurable / Errored)
//   - View-mode toggle (list / card)
//   - Filter sheet trigger
//   - Plugin panel toolbar (Install split-button / Check updates / Sync registry)
//
// Lives inside the FeaturePageShell's `toolbar` slot so it stays stuck to
// the top of the center pane on every breakpoint.

import { useTranslations } from "next-intl"
import { FilterIcon, SearchIcon } from "lucide-react"
import { usePluginsStore } from "@/stores/plugins"
import { usePlugins } from "@/hooks/plugins"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { PluginCategorySheet } from "../dialogs/plugin-category-sheet"
import { PluginPanelToolbar } from "../plugin-panel-toolbar"
import { PluginActiveFilters } from "./plugin-active-filters"
import { PluginLibrarySubFilter } from "./plugin-library-sub-filter"
import { PluginLibraryViewToggle } from "./plugin-library-view-toggle"

interface Props {
  onCheckUpdates?: () => void
  onSyncRegistry?: () => Promise<void> | void
  syncing?: boolean
}

export function PluginLibraryHeader({ onCheckUpdates, onSyncRegistry, syncing }: Props) {
  const t = useTranslations("plugins.panel")
  const filters = usePluginsStore((s) => s.filters)
  const setQuery = usePluginsStore((s) => s.setQuery)
  const setFilterSheetOpen = usePluginsStore((s) => s.setFilterSheetOpen)
  const { filtered, totals, loading } = usePlugins()
  // Only surface the count when the visible set is narrower than the total
  // (or when a search query is active). Hides on the unfiltered "All" view
  // so the header stays tidy when there's nothing to communicate.
  const showCount = !loading && totals.total > 0 && filtered.length !== totals.total

  return (
    <div className="w-full space-y-2">
      <div className="flex items-center gap-2">
        <div className="relative flex-1 min-w-0">
          <SearchIcon className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <Input
            value={filters.query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("searchPlaceholder")}
            className="pl-7 h-8 text-sm"
            aria-label={t("searchPlaceholder")}
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setFilterSheetOpen(true)}
          aria-label={t("filtersButton")}
          data-testid="plugin-library-filters-trigger"
        >
          <FilterIcon className="size-3.5" />
          <span className="hidden sm:inline ml-1.5">{t("filtersButton")}</span>
        </Button>
        {/* Capability rail is inline on lg+; narrow viewports get the
            equivalent affordance as a Sheet trigger so the capability
            filter axis stays reachable. */}
        <PluginCategorySheet className="lg:hidden" />
        <PluginLibraryViewToggle />
        <PluginPanelToolbar
          onCheckUpdates={onCheckUpdates}
          onSyncRegistry={onSyncRegistry}
          syncing={syncing}
        />
      </div>
      <PluginLibrarySubFilter />
      <PluginActiveFilters />
      {showCount && (
        <p
          className="text-xs text-muted-foreground"
          role="status"
          aria-live="polite"
          data-testid="plugin-library-result-count"
        >
          {filtered.length === 0
            ? t("resultsCountEmpty", { total: totals.total })
            : t("resultsCount", { count: filtered.length, total: totals.total })}
        </p>
      )}
    </div>
  )
}
