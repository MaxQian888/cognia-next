"use client"

// Header strip for the /plugins panel. Surfaces the search box (which
// drives `usePluginsStore.filters.query`) and the filter-sheet trigger.
// Total count + filtered count badges keep the user oriented when
// filters are active. On `md:` and wider the title and search row sit
// side-by-side to make better use of horizontal space.

import { useTranslations } from "next-intl"
import { BoxesIcon, FilterIcon, SearchIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { usePluginsStore } from "@/stores/plugins"
import { usePlugins } from "@/hooks/plugins"

interface Props {
  /** Optional subtitle override; defaults to the i18n description string. */
  subtitle?: string
}

export function PluginPanelHeader({ subtitle }: Props) {
  const t = useTranslations("plugins")
  const filters = usePluginsStore((s) => s.filters)
  const setQuery = usePluginsStore((s) => s.setQuery)
  const setFilterSheetOpen = usePluginsStore((s) => s.setFilterSheetOpen)
  const { totals, filtered } = usePlugins()

  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between md:gap-4">
      <div className="space-y-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <BoxesIcon className="size-5 shrink-0" />
          <h1 className="text-lg font-semibold">{t("title")}</h1>
          <Badge variant="secondary" className="text-xs">
            {t("panel.totalBadge", { count: totals.total })}
          </Badge>
          {filtered.length !== totals.total && (
            <Badge variant="outline" className="text-xs">
              {t("panel.filteredBadge", { count: filtered.length })}
            </Badge>
          )}
        </div>
        {subtitle ?? <p className="text-sm text-muted-foreground">{t("description")}</p>}
      </div>
      <div className="flex items-center gap-2 md:max-w-md md:flex-1 md:justify-end">
        <div className="relative flex-1 md:max-w-md">
          <SearchIcon className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <Input
            value={filters.query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("panel.searchPlaceholder")}
            className="pl-7"
            aria-label={t("panel.searchPlaceholder")}
          />
        </div>
        <Button variant="outline" size="sm" onClick={() => setFilterSheetOpen(true)}>
          <FilterIcon className="size-3.5 mr-1.5" />
          <span className="hidden sm:inline">{t("panel.filtersButton")}</span>
        </Button>
      </div>
    </div>
  )
}
