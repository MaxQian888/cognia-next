"use client"

// Library's contribution to the page header's second tier. Supplies the
// three things that tier takes — search, segments, section tools — to the
// shared `PluginSectionToolbar`, which owns the layout and the zero-count
// rule. Library's tools are the filter-sheet trigger, the capability sheet
// (narrow panes only), the sort select, and the list/card view toggle.
//
// Lives inside the FeaturePageHeader controls slot. Primary and page-level
// actions are hosted by the header's fixed action tier so they remain visible
// when this dense controls row scrolls horizontally.

import { useTranslations } from "next-intl"
import { ArrowDownUpIcon, FilterIcon } from "lucide-react"
import { usePluginsStore, type PluginSortMode } from "@/stores/plugins"
import { usePlugins } from "@/hooks/plugins"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { PluginCategorySheet } from "../dialogs/plugin-category-sheet"
import { PluginSectionToolbar } from "../plugin-section-toolbar"
import { PluginActiveFilters } from "./plugin-active-filters"
import { useLibrarySubFilterSegments } from "./plugin-library-sub-filter"
import { PluginLibraryViewToggle } from "./plugin-library-view-toggle"

const SORT_MODES: readonly PluginSortMode[] = ["name", "updated", "usage", "rating"]

export function PluginLibraryHeader() {
  const t = useTranslations("plugins.panel")
  const tSort = useTranslations("plugins.filterSheet")
  // Narrow selectors — subscribing to the whole `filters` object would
  // re-render the header (and its toolbar subtree) on every filter change,
  // including ones this component doesn't display.
  const query = usePluginsStore((s) => s.filters.query)
  const sort = usePluginsStore((s) => s.filters.sort)
  const setQuery = usePluginsStore((s) => s.setQuery)
  const setFilters = usePluginsStore((s) => s.setFilters)
  const setFilterSheetOpen = usePluginsStore((s) => s.setFilterSheetOpen)
  const { filtered, totals, loading } = usePlugins()
  // Library's status axis rides the toolbar's segments slot — the same
  // control Governance's view picker uses, and no longer a second copy of
  // the left rail's old sub-items.
  const segments = useLibrarySubFilterSegments()
  // Only surface the count when the visible set is narrower than the total
  // (or when a search query is active). Hides on the unfiltered "All" view
  // so the header stays tidy when there's nothing to communicate.
  const showCount = !loading && totals.total > 0 && filtered.length !== totals.total

  return (
    <PluginSectionToolbar
      testId="plugin-library-toolbar"
      search={{
        value: query,
        onChange: setQuery,
        placeholder: t("searchPlaceholder"),
        testId: "plugin-library-search",
      }}
      segments={segments}
      tools={
        <>
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
          <Select value={sort} onValueChange={(v) => setFilters({ sort: v as PluginSortMode })}>
            <SelectTrigger
              className="h-8 w-auto gap-1.5 text-xs"
              aria-label={t("sortBy")}
              data-testid="plugin-library-sort"
            >
              <ArrowDownUpIcon className="size-3.5" />
              <span className="hidden sm:inline">
                <SelectValue />
              </span>
            </SelectTrigger>
            <SelectContent>
              {SORT_MODES.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {tSort(`sortMode.${mode}` as never)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <PluginLibraryViewToggle />
        </>
      }
      status={
        <>
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
        </>
      }
    />
  )
}
