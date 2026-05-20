"use client"

/**
 * Bottom Sheet that exposes the URL-driven sort + filter controls. Used by
 * the mobile body header (and the desktop toolbar, via the same trigger).
 *
 * Changes flow back into `useDiscoverRouteState` immediately so the grid
 * reorders / filters on each tap without a separate "Apply" step. The
 * Reset button collapses both knobs back to their defaults, which also
 * strips them from the URL so deep-links stay short.
 */

import { useTranslations } from "next-intl"
import { SlidersHorizontalIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import {
  DEFAULT_DISCOVER_FILTER,
  DEFAULT_DISCOVER_SORT,
  DISCOVER_FILTERS,
  DISCOVER_SORTS,
  type DiscoverFilter,
  type DiscoverSort,
} from "@/hooks/discover/use-discover-route-state"
import { cn } from "@/lib/utils"

export interface SortFilterSheetProps {
  sort: DiscoverSort
  filter: DiscoverFilter
  onSortChange: (next: DiscoverSort) => void
  onFilterChange: (next: DiscoverFilter) => void
  /** Optional override for the trigger button — defaults to a labelled icon button. */
  trigger?: React.ReactNode
  className?: string
}

export function SortFilterSheet({
  sort,
  filter,
  onSortChange,
  onFilterChange,
  trigger,
  className,
}: SortFilterSheetProps) {
  const t = useTranslations("discover")
  const hasOverride = sort !== DEFAULT_DISCOVER_SORT || filter !== DEFAULT_DISCOVER_FILTER

  return (
    <Sheet>
      <SheetTrigger asChild>
        {trigger ?? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn("gap-2", className)}
            data-testid="discover-sort-filter-trigger"
            aria-label={t("sortFilter.trigger")}
          >
            <SlidersHorizontalIcon className="size-4" />
            <span className="hidden sm:inline">{t("sortFilter.trigger")}</span>
            {hasOverride ? (
              <Badge
                variant="default"
                className="ml-1 size-2 rounded-full p-0"
                aria-hidden="true"
              />
            ) : null}
          </Button>
        )}
      </SheetTrigger>
      <SheetContent
        side="bottom"
        className="max-h-[80vh] gap-0 p-0"
        data-testid="discover-sort-filter-sheet"
      >
        <SheetHeader className="border-b px-4 py-3">
          <SheetTitle>{t("sortFilter.title")}</SheetTitle>
        </SheetHeader>
        <div className="flex flex-col gap-6 overflow-y-auto px-4 py-4">
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t("sortFilter.sortLabel")}
            </h3>
            <div
              className="flex flex-wrap gap-2"
              role="radiogroup"
              aria-label={t("sortFilter.sortLabel")}
            >
              {DISCOVER_SORTS.map((value) => {
                const active = sort === value
                return (
                  <Button
                    key={value}
                    type="button"
                    variant={active ? "default" : "outline"}
                    size="sm"
                    role="radio"
                    aria-checked={active}
                    onClick={() => onSortChange(value)}
                    data-testid={`discover-sort-${value}`}
                  >
                    {t(`sortFilter.sort.${value}`)}
                  </Button>
                )
              })}
            </div>
          </section>
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t("sortFilter.filterLabel")}
            </h3>
            <div
              className="flex flex-wrap gap-2"
              role="radiogroup"
              aria-label={t("sortFilter.filterLabel")}
            >
              {DISCOVER_FILTERS.map((value) => {
                const active = filter === value
                return (
                  <Button
                    key={value}
                    type="button"
                    variant={active ? "default" : "outline"}
                    size="sm"
                    role="radio"
                    aria-checked={active}
                    onClick={() => onFilterChange(value)}
                    data-testid={`discover-filter-${value}`}
                  >
                    {t(`sortFilter.filter.${value}`)}
                  </Button>
                )
              })}
            </div>
          </section>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!hasOverride}
            onClick={() => {
              onSortChange(DEFAULT_DISCOVER_SORT)
              onFilterChange(DEFAULT_DISCOVER_FILTER)
            }}
            data-testid="discover-sort-filter-reset"
            className="self-start"
          >
            {t("sortFilter.reset")}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
