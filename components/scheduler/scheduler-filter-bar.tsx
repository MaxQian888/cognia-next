"use client"

/**
 * SchedulerFilterBar — the single filter row above the scheduler task list.
 *
 * It replaces two stacked chip rows (four status chips + seven kind chips =
 * eleven buttons and ~100px of vertical space) that also happened to disagree:
 * the status row counted app-only tasks while the kind row counted the merged
 * cross-source list, so the sidebar showed "All 2" directly above "All 4".
 *
 * Both axes now read from the same `UnifiedScheduledItem[]` the list renders:
 *
 *   - status  → a three-way segmented control (all / active / paused), the
 *     mutually-exclusive question, always visible with live counts;
 *   - kind + `/loop` → a menu, the multi-select question, collapsed behind one
 *     trigger that carries a badge with how many kinds are pinned.
 *
 * The counts on the status control describe the *kind-filtered* list, so they
 * always predict what pressing them will show.
 */

import { useTranslations } from "next-intl"
import { ListFilter, RotateCcw } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/utils"
import {
  UNIFIED_STATUS_FILTERS,
  isUnifiedStatusFilter,
  type UnifiedStatusFilter,
} from "@/lib/scheduler/unified-filter"
import { SCHEDULED_ITEM_KINDS, type ScheduledItemKind } from "@/types/scheduler/unified"

export interface SchedulerFilterBarProps {
  status: UnifiedStatusFilter
  onStatusChange: (status: UnifiedStatusFilter) => void
  /** Counts for the three status buckets, over the kind-filtered list. */
  statusCounts: Record<UnifiedStatusFilter, number>
  selectedKinds: ReadonlySet<ScheduledItemKind>
  onToggleKind: (kind: ScheduledItemKind) => void
  /** Per-kind totals over the *unfiltered* list, so pinning one is reversible. */
  countsByKind: Record<ScheduledItemKind, number>
  loopOnly: boolean
  onLoopOnlyChange: (loopOnly: boolean) => void
  /** How many `/loop` items exist overall — hides the row when there are none. */
  loopCount: number
  /** Resets kinds + loop (the menu's own axes). */
  onClearKindFilters: () => void
  className?: string
}

export function SchedulerFilterBar({
  status,
  onStatusChange,
  statusCounts,
  selectedKinds,
  onToggleKind,
  countsByKind,
  loopOnly,
  onLoopOnlyChange,
  loopCount,
  onClearKindFilters,
  className,
}: SchedulerFilterBarProps) {
  const t = useTranslations("scheduler")
  const pinnedCount = selectedKinds.size + (loopOnly ? 1 : 0)
  const hasMenuFilters = pinnedCount > 0

  const statusLabel: Record<UnifiedStatusFilter, string> = {
    all: t("filter.all"),
    active: t("statuses.active"),
    paused: t("statuses.paused"),
  }

  return (
    <div
      data-testid="scheduler-filter-bar"
      className={cn("flex items-center gap-1.5 px-3 pb-2", className)}
    >
      <ToggleGroup
        type="single"
        value={status}
        onValueChange={(value) => {
          // Radix emits "" when the pressed item is toggled off; keep the
          // control single-valued by ignoring that instead of clearing.
          if (isUnifiedStatusFilter(value)) onStatusChange(value)
        }}
        variant="outline"
        size="sm"
        spacing={0}
        aria-label={t("filter.statusLabel")}
        className="w-auto min-w-0 flex-1"
      >
        {UNIFIED_STATUS_FILTERS.map((key) => (
          <ToggleGroupItem
            key={key}
            value={key}
            data-testid={`scheduler-status-filter-${key}`}
            className="h-7 min-w-0 flex-1 gap-1 px-2 text-[11px] data-[state=on]:border-primary/30 data-[state=on]:bg-primary/10 data-[state=on]:text-primary"
          >
            <span className="truncate">{statusLabel[key]}</span>
            <span className="shrink-0 tabular-nums text-[10px] opacity-70">
              {statusCounts[key]}
            </span>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            data-testid="scheduler-kind-filter-menu"
            data-active={hasMenuFilters || undefined}
            aria-label={t("filterBar.kindMenu")}
            className={cn(
              "relative h-7 shrink-0 px-2",
              hasMenuFilters && "border-primary/30 bg-primary/10 text-primary"
            )}
          >
            <ListFilter className="h-3.5 w-3.5" aria-hidden="true" />
            {hasMenuFilters && (
              <span
                data-testid="scheduler-kind-filter-count"
                className="tabular-nums text-[10px] font-medium"
              >
                {pinnedCount}
              </span>
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel className="text-[11px] uppercase tracking-wide text-muted-foreground">
            {t("filter.typeLabel")}
          </DropdownMenuLabel>
          {SCHEDULED_ITEM_KINDS.map((kind) => {
            const count = countsByKind[kind] ?? 0
            return (
              <DropdownMenuCheckboxItem
                key={kind}
                checked={selectedKinds.has(kind)}
                onCheckedChange={() => onToggleKind(kind)}
                onSelect={(event) => event.preventDefault()}
                data-testid={`scheduler-kind-filter-${kind}`}
                className={cn("text-xs", count === 0 && "text-muted-foreground")}
              >
                <span className="flex-1">{t(`kindFilter.${kind}`)}</span>
                <span className="tabular-nums text-[10px] text-muted-foreground">{count}</span>
              </DropdownMenuCheckboxItem>
            )
          })}

          {loopCount > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem
                checked={loopOnly}
                onCheckedChange={(checked) => onLoopOnlyChange(checked === true)}
                onSelect={(event) => event.preventDefault()}
                data-testid="scheduler-loop-only-filter"
                className="text-xs"
              >
                <span className="flex-1">{t("filterBar.loopOnly")}</span>
                <span className="tabular-nums text-[10px] text-muted-foreground">{loopCount}</span>
              </DropdownMenuCheckboxItem>
            </>
          )}

          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={!hasMenuFilters}
            onSelect={() => onClearKindFilters()}
            data-testid="scheduler-clear-kind-filters"
            className="text-xs"
          >
            <RotateCcw className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
            {t("filterBar.clear")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
