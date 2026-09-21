"use client"

/**
 * The provider list's category and status filters, as one toolbar row.
 *
 * They used to be two `flex-wrap` bands of chips above the list: six category
 * tabs and seven status buttons. Both wrapped, so on a 320px rail that was
 * four rows of chrome, and once the rail started giving up width to the detail
 * column (`clamp(200px, 30cqi, …)`) it became seven rows, taller than the list
 * it was filtering.
 *
 * Now: one button that says how many filters are on, a popover holding both
 * axes, and a chip per active filter so the state stays visible without the
 * popover open. Nothing wraps until two filters are active at once, and then
 * it wraps by one row rather than by six.
 */

import { Check, Filter, X } from "lucide-react"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

import { PROVIDER_CATEGORY_FILTERS } from "./provider-status-utils"

/** Connection-status quick filters applied locally to the visible list. */
export const STATUS_FILTERS = [
  { value: "all", key: "statusAll" },
  { value: "connected", key: "statusConnected" },
  { value: "warning", key: "statusWarning" },
  { value: "limited", key: "statusLimited" },
  { value: "untested", key: "statusUntested" },
  { value: "not-configured", key: "statusUnconfigured" },
  { value: "error", key: "statusError" },
] as const

export type ProviderStatusFilterValue = (typeof STATUS_FILTERS)[number]["value"]

export interface ProviderFilterPopoverProps {
  categoryFilter: string
  onCategoryChange: (category: string) => void
  statusFilter: ProviderStatusFilterValue
  onStatusFilterChange: (status: ProviderStatusFilterValue) => void
  /** Also clears the search box, which the rail owns. */
  onClearAll: () => void
  /** True when the search box has text, so "clear all" says what it does. */
  searchActive?: boolean
}

function OptionRow({
  label,
  selected,
  onSelect,
  testid,
}: {
  label: string
  selected: boolean
  onSelect: () => void
  testid: string
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      role="menuitemradio"
      aria-checked={selected}
      data-testid={testid}
      onClick={onSelect}
      className={cn(
        "h-auto w-full justify-start gap-2 rounded-md px-2 py-1.5 text-left text-xs font-normal",
        "hover:bg-accent hover:text-accent-foreground",
        selected && "bg-muted font-medium"
      )}
    >
      <Check className={cn("h-3.5 w-3.5 shrink-0", selected ? "opacity-100" : "opacity-0")} />
      <span className="min-w-0 truncate">{label}</span>
    </Button>
  )
}

export function ProviderFilterPopover({
  categoryFilter,
  onCategoryChange,
  statusFilter,
  onStatusFilterChange,
  onClearAll,
  searchActive = false,
}: ProviderFilterPopoverProps) {
  const t = useTranslations("providers")

  const categoryActive = categoryFilter !== "all"
  const statusActive = statusFilter !== "all"
  const activeCount = (categoryActive ? 1 : 0) + (statusActive ? 1 : 0)
  const statusKey = STATUS_FILTERS.find((s) => s.value === statusFilter)?.key ?? "statusAll"

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1 border-b px-3 py-2">
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            size="sm"
            variant={activeCount > 0 ? "secondary" : "ghost"}
            className="h-7 shrink-0 gap-1.5 px-2 text-xs"
            aria-label={t("sidebar.filterLabel")}
            data-testid="provider-filter-trigger"
          >
            <Filter className="h-3.5 w-3.5" />
            {t("sidebar.filterLabel")}
            {activeCount > 0 && (
              <Badge
                variant="secondary"
                className="h-4 min-w-4 px-1 text-[10px] tabular-nums"
                data-testid="provider-filter-count"
              >
                {activeCount}
              </Badge>
            )}
          </Button>
        </PopoverTrigger>
        {/* `max-h` + scroll: the category axis grows with the catalog, and a
            popover that outgrows the pane is how the old chip bands started. */}
        <PopoverContent
          align="start"
          className="max-h-80 w-56 overflow-y-auto p-2"
          data-testid="provider-filter-popover"
        >
          <p className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t("sidebar.categoryLabel")}
          </p>
          <div role="group" aria-label={t("sidebar.categoryLabel")}>
            {PROVIDER_CATEGORY_FILTERS.map((key) => (
              <OptionRow
                key={key}
                label={t(`categories.${key}`)}
                selected={categoryFilter === key}
                onSelect={() => onCategoryChange(key)}
                testid={`provider-filter-category-${key}`}
              />
            ))}
          </div>
          <p className="mt-2 px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t("sidebar.statusLabel")}
          </p>
          <div role="group" aria-label={t("sidebar.statusLabel")}>
            {STATUS_FILTERS.map(({ value, key }) => (
              <OptionRow
                key={value}
                label={t(`sidebar.${key}`)}
                selected={statusFilter === value}
                onSelect={() => onStatusFilterChange(value)}
                testid={`provider-filter-status-${value}`}
              />
            ))}
          </div>
        </PopoverContent>
      </Popover>

      {/* Active filters stay legible with the popover closed, and each chip is
          its own undo rather than making the user reopen the popover to find
          the "All" row. */}
      {categoryActive && (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="h-7 shrink gap-1 overflow-hidden px-2 text-xs"
          onClick={() => onCategoryChange("all")}
          aria-label={t("sidebar.removeFilter", { name: t(`categories.${categoryFilter}`) })}
          data-testid="provider-filter-chip-category"
        >
          <span className="min-w-0 truncate">{t(`categories.${categoryFilter}`)}</span>
          <X className="h-3 w-3 shrink-0" />
        </Button>
      )}
      {statusActive && (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="h-7 shrink gap-1 overflow-hidden px-2 text-xs"
          onClick={() => onStatusFilterChange("all")}
          aria-label={t("sidebar.removeFilter", { name: t(`sidebar.${statusKey}`) })}
          data-testid="provider-filter-chip-status"
        >
          <span className="min-w-0 truncate">{t(`sidebar.${statusKey}`)}</span>
          <X className="h-3 w-3 shrink-0" />
        </Button>
      )}
      {(activeCount > 0 || searchActive) && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 shrink-0 gap-1 px-2 text-xs"
          onClick={onClearAll}
          data-testid="provider-filter-clear"
        >
          <X className="h-3 w-3" />
          {t("sidebar.clearFilters")}
        </Button>
      )}
    </div>
  )
}
