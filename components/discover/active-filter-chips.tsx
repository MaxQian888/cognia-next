"use client"

/**
 * Inline, removable chips echoing the discover page's active sort + filter —
 * the App Store / VS Code marketplace pattern where the toolbar surfaces which
 * refinements are live instead of hiding them behind a popover. Each chip's ✕
 * resets just that knob back to its default (which also strips it from the URL,
 * see `useDiscoverRouteState`). Renders nothing when both are at defaults.
 *
 * Shared by the desktop toolbar and the mobile header so the two surfaces stay
 * in sync. The sort/filter values + setters come from `useDiscoverRouteState`.
 */

import { useTranslations } from "next-intl"
import { XIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import {
  DEFAULT_DISCOVER_FILTER,
  DEFAULT_DISCOVER_SORT,
  type DiscoverFilter,
  type DiscoverSort,
} from "@/hooks/discover/use-discover-route-state"
import { cn } from "@/lib/utils"

export interface ActiveFilterChipsProps {
  sort: DiscoverSort
  filter: DiscoverFilter
  onSortChange: (next: DiscoverSort) => void
  onFilterChange: (next: DiscoverFilter) => void
  className?: string
}

export function ActiveFilterChips({
  sort,
  filter,
  onSortChange,
  onFilterChange,
  className,
}: ActiveFilterChipsProps) {
  const t = useTranslations("discover")
  const sortActive = sort !== DEFAULT_DISCOVER_SORT
  const filterActive = filter !== DEFAULT_DISCOVER_FILTER

  if (!sortActive && !filterActive) return null

  return (
    <div
      className={cn("flex flex-wrap items-center gap-1.5", className)}
      data-testid="discover-active-filters"
    >
      {sortActive ? (
        <Chip
          label={t("activeFilters.sortChip", { value: t(`sortFilter.sort.${sort}`) })}
          removeLabel={t("activeFilters.clearSort")}
          onRemove={() => onSortChange(DEFAULT_DISCOVER_SORT)}
          testid="discover-active-filter-sort"
        />
      ) : null}
      {filterActive ? (
        <Chip
          label={t("activeFilters.filterChip", { value: t(`sortFilter.filter.${filter}`) })}
          removeLabel={t("activeFilters.clearFilter")}
          onRemove={() => onFilterChange(DEFAULT_DISCOVER_FILTER)}
          testid="discover-active-filter-filter"
        />
      ) : null}
    </div>
  )
}

function Chip({
  label,
  removeLabel,
  onRemove,
  testid,
}: {
  label: string
  removeLabel: string
  onRemove: () => void
  testid: string
}) {
  return (
    <Badge variant="secondary" className="gap-1 pr-1 font-normal" data-testid={testid}>
      <span className="truncate">{label}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={removeLabel}
        data-testid={`${testid}-remove`}
        className="flex size-4 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted-foreground/20 hover:text-foreground"
      >
        <XIcon className="size-3" />
      </button>
    </Badge>
  )
}
