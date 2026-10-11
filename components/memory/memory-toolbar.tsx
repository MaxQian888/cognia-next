"use client"

/**
 * The single control band for `/memory`, rendered into the page header's
 * `controls` slot.
 *
 * It replaces two things the old panel stacked in the page body: a row of five
 * gradient stat tiles (which were filters wearing a dashboard's clothes — the
 * "pending review" tile was literally a toggle button) and a `flex-wrap` row of
 * eight controls that folded into two or three ragged lines at medium widths.
 *
 * The split mirrors `components/issues/filter-bar/issue-filter-bar.tsx`: quick views
 * and Filter change *which rows exist*, Display changes how they are ordered
 * and how dense they are. Every facet option comes from
 * `collectMemoryFacets` over the rows the current view already narrowed to, so
 * the menu can never offer a filter that returns nothing.
 */

import { useTranslations } from "next-intl"
import { ListFilterIcon, SearchIcon, SlidersHorizontalIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import {
  clearMemoryFacets,
  countActiveMemoryFilters,
  MEMORY_QUICK_VIEWS,
  type MemoryFacets,
  type MemoryFilter,
  type MemoryQuickViewId,
  type MemorySortKey,
} from "@/lib/memory/history-filter"
import { cn } from "@/lib/utils"
import { useMemoryFacetGroups } from "./memory-facet-groups"

/** Row height preset — mirrors the logging workspace's density switch. */
export type MemoryDensity = "comfortable" | "compact"

export const MEMORY_SORT_KEYS: readonly MemorySortKey[] = [
  "recent",
  "importance",
  "accessed",
  "created",
]

export interface MemoryToolbarProps {
  view: MemoryQuickViewId
  onViewChange: (view: MemoryQuickViewId) => void
  viewCounts: Record<MemoryQuickViewId, number>
  /** Facet + query axes. The view owns status/pin/review and is not in here. */
  filter: MemoryFilter
  onFilterChange: (filter: MemoryFilter) => void
  /** Derived from the rows the current view matched. */
  facets: MemoryFacets
  /**
   * Workspace id → display name, so the Workspace facet is readable.
   *
   * Optional: an id with no entry renders as the raw id rather than
   * disappearing, because a workspace deleted while its claims survive is
   * exactly the case the user needs to be able to filter for.
   */
  projectNames?: Record<string, string>
  sort: MemorySortKey
  onSortChange: (sort: MemorySortKey) => void
  density: MemoryDensity
  onDensityChange: (density: MemoryDensity) => void
}

export function MemoryToolbar({
  view,
  onViewChange,
  viewCounts,
  filter,
  onFilterChange,
  facets,
  projectNames,
  sort,
  onSortChange,
  density,
  onDensityChange,
}: MemoryToolbarProps) {
  const t = useTranslations("memory.panel")
  const groups = useMemoryFacetGroups({ facets, filter, onFilterChange, projectNames })
  const activeCount = countActiveMemoryFilters(filter)
  const hasFacets = groups.some((group) => group.options.length > 0)

  return (
    <div className="flex min-w-0 items-center gap-2" data-testid="memory-toolbar">
      <MemoryQuickViews
        view={view}
        onViewChange={onViewChange}
        viewCounts={viewCounts}
        className="min-w-0 flex-1"
      />

      <div className="relative shrink-0">
        <SearchIcon
          className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          value={filter.query ?? ""}
          onChange={(event) => onFilterChange({ ...filter, query: event.target.value })}
          placeholder={t("searchPlaceholder")}
          aria-label={t("searchLabel")}
          className="h-8 w-32 pl-8 @xl/feature-header:w-40 @2xl/feature-header:w-56"
          data-testid="memory-search"
        />
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 shrink-0"
            data-testid="memory-filter-menu"
          >
            <ListFilterIcon className="size-4" />
            <span className="hidden @xl/feature-header:inline">{t("filter.label")}</span>
            {activeCount > 0 ? (
              <Badge variant="secondary" className="ml-1 h-4 px-1 text-[10px] tabular-nums">
                {activeCount}
              </Badge>
            ) : null}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-[70vh] w-60 overflow-y-auto">
          {!hasFacets ? (
            <DropdownMenuLabel className="font-normal text-muted-foreground">
              {t("filter.none")}
            </DropdownMenuLabel>
          ) : null}

          {groups.map((group) => (
            <FacetGroup
              key={group.key}
              label={group.label}
              options={group.options}
              selected={group.selected}
              render={group.render}
              onToggle={group.toggle}
            />
          ))}

          {activeCount > 0 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => onFilterChange(clearMemoryFacets(filter))}
                data-testid="memory-filter-clear"
              >
                {t("filter.clear")}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 shrink-0"
            data-testid="memory-display-menu"
          >
            <SlidersHorizontalIcon className="size-4" />
            <span className="hidden @xl/feature-header:inline">{t("display.label")}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuLabel>{t("display.sort")}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={sort}
            onValueChange={(value) => onSortChange(value as MemorySortKey)}
          >
            {MEMORY_SORT_KEYS.map((key) => (
              <DropdownMenuRadioItem key={key} value={key} data-testid={`memory-sort-${key}`}>
                {t(`sort.${key}`)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>{t("display.density")}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={density}
            onValueChange={(value) => onDensityChange(value as MemoryDensity)}
          >
            <DropdownMenuRadioItem value="comfortable">
              {t("display.comfortable")}
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="compact">{t("display.compact")}</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export interface MemoryQuickViewsProps {
  view: MemoryQuickViewId
  onViewChange: (view: MemoryQuickViewId) => void
  viewCounts: Record<MemoryQuickViewId, number>
  className?: string
  /** Taller chips for a touch layout. */
  size?: "default" | "touch"
}

/**
 * The quick views (All / Pinned / Needs review / Conflicts / Archived) as one
 * tab list. It scrolls sideways instead of wrapping or pushing the search and
 * menus off the edge, which is what clipped "Display" in a 900px window.
 */
export function MemoryQuickViews({
  view,
  onViewChange,
  viewCounts,
  className,
  size = "default",
}: MemoryQuickViewsProps) {
  const t = useTranslations("memory.panel")
  return (
    <div
      role="tablist"
      aria-label={t("viewsLabel")}
      className={cn(
        "flex items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className
      )}
      data-testid="memory-view-chips"
    >
      {MEMORY_QUICK_VIEWS.map((candidate) => {
        const selected = candidate.id === view
        const count = viewCounts[candidate.id] ?? 0
        return (
          <button
            key={candidate.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onViewChange(candidate.id)}
            data-testid={`memory-view-${candidate.id}`}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-pill border whitespace-nowrap",
              size === "touch" ? "h-8 px-3 text-sm" : "px-2.5 py-1 text-xs",
              "motion-safe:transition-colors motion-safe:duration-150",
              selected
                ? "border-primary/40 bg-primary/10 text-foreground"
                : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            )}
          >
            <span>{t(`views.${candidate.labelKey}`)}</span>
            <span
              className={cn("tabular-nums", selected ? "text-primary" : "text-muted-foreground/70")}
            >
              {count}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function FacetGroup<T extends string>({
  label,
  options,
  selected,
  render,
  onToggle,
}: {
  label: string
  options: readonly { value: T; count: number }[]
  selected: readonly T[] | undefined
  render: (value: T) => string
  onToggle: (value: T) => void
}) {
  if (options.length === 0) return null
  return (
    <>
      <DropdownMenuLabel>{label}</DropdownMenuLabel>
      {options.map((option) => (
        <DropdownMenuCheckboxItem
          key={option.value}
          checked={(selected ?? []).includes(option.value)}
          onCheckedChange={() => onToggle(option.value)}
          onSelect={(event) => event.preventDefault()}
        >
          <span className="flex-1 truncate">{render(option.value)}</span>
          <span className="ml-2 tabular-nums text-xs text-muted-foreground">{option.count}</span>
        </DropdownMenuCheckboxItem>
      ))}
    </>
  )
}
