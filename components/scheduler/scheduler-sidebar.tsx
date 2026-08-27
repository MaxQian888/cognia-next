"use client"

/**
 * SchedulerSidebar — the task list rail of the `/scheduler` page.
 *
 * It renders exactly one universe: the merged `UnifiedScheduledItem[]` from
 * every registered source. The search box and the filter row above the list
 * narrow *that* list, which is the whole point of the rewrite — they used to
 * drive an app-only `ScheduledTask[]` that was never rendered, so typing in
 * the search box changed nothing on screen while quietly re-querying the store
 * behind the overview's numbers.
 *
 * Filter state lives on the page (it also drives keyboard navigation and the
 * empty states), and arrives here pre-derived as {@link UnifiedFacets}.
 */

import React, { useCallback, useMemo } from "react"
import { AlertTriangle, Calendar, Search, X } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { Badge } from "@/components/ui/badge"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { cn } from "@/lib/utils"
import type { UnifiedFacets, UnifiedStatusFilter } from "@/lib/scheduler/unified-filter"
import {
  SCHEDULED_ITEM_KINDS,
  type ScheduledItemKind,
  type UnifiedScheduledItem,
} from "@/types/scheduler/unified"

import { Surface } from "@/components/surface/surface"
import { SchedulerFilterBar } from "./scheduler-filter-bar"
import { UnifiedTaskSidebarItem } from "./unified-task-sidebar-item"
import { TaskListEmptyState } from "./empty-states"

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface SchedulerSidebarProps {
  /** Every unified item, before filtering — the denominator in the footer. */
  items: UnifiedScheduledItem[]
  /** Pre-derived rows + facet counts for the filter row. */
  facets: UnifiedFacets

  /** `unifiedId` of the row rendered in the detail pane, if any. */
  selectedUnifiedId: string | null
  /** `unifiedId` the keyboard cursor is on, if any. */
  highlightedUnifiedId?: string | null

  schedulerStatus: string // 'running' | 'stopped' | 'idle'
  schedulerHost?: "local" | "remote"

  searchQuery: string
  onSearchChange: (query: string) => void

  statusFilter: UnifiedStatusFilter
  onStatusFilterChange: (status: UnifiedStatusFilter) => void
  selectedKinds: ReadonlySet<ScheduledItemKind>
  onToggleKind: (kind: ScheduledItemKind) => void
  loopOnly: boolean
  onLoopOnlyChange: (loopOnly: boolean) => void
  /** Resets kind + loop pins (the filter menu's own axes). */
  onClearKindFilters: () => void
  /** Resets every axis including search — the filtered empty state's CTA. */
  onResetFilters: () => void

  onSelectItem: (item: UnifiedScheduledItem) => void
  onRunNow?: (item: UnifiedScheduledItem) => void
  onPause?: (item: UnifiedScheduledItem) => void
  onResume?: (item: UnifiedScheduledItem) => void
  onDelete?: (item: UnifiedScheduledItem) => void

  /** Multi-select: which unifiedIds are currently checked. */
  selectedUnifiedIds?: string[]
  /** Multi-select: toggle membership on a row. */
  onToggleUnifiedSelection?: (item: UnifiedScheduledItem) => void

  /** Empty-state CTA — opens the new-task sheet. */
  onCreate?: () => void

  /**
   * Kinds whose source failed to load, from `useUnifiedScheduledItems().errors`.
   * The hook has always collected these ("for the UI to decide whether to
   * render a per-source warning chip") and nothing rendered them, so a source
   * that threw on subscribe looked exactly like a source with no items — an
   * empty list reading as "you have nothing scheduled".
   */
  sourceErrors?: Partial<Record<ScheduledItemKind, unknown>>
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Chrome wrapper — the offcanvas/collapsible `<Sidebar>` used on tablet and
 * mobile. Desktop renders `SchedulerSidebarContent` directly inside a
 * resizable panel instead (mirrors the InboxSidebar/InboxSidebarContent
 * dual-export pattern).
 */
export function SchedulerSidebar(props: SchedulerSidebarProps) {
  return (
    <Sidebar collapsible="icon" className="border-r">
      <SchedulerSidebarContent {...props} />
    </Sidebar>
  )
}

export function SchedulerSidebarContent({
  items,
  facets,
  selectedUnifiedId,
  highlightedUnifiedId,
  schedulerStatus,
  schedulerHost = "local",
  searchQuery,
  onSearchChange,
  statusFilter,
  onStatusFilterChange,
  selectedKinds,
  onToggleKind,
  loopOnly,
  onLoopOnlyChange,
  onClearKindFilters,
  onResetFilters,
  onSelectItem,
  onRunNow,
  onPause,
  onResume,
  onDelete,
  selectedUnifiedIds,
  onToggleUnifiedSelection,
  onCreate,
  sourceErrors,
}: SchedulerSidebarProps) {
  const t = useTranslations("scheduler")
  const locale = useLocale()

  // `Intl.ListFormat`, not a hardcoded separator: "、" is right for zh-CN and
  // wrong for English, and the reverse for ", ".
  const failedKinds = useMemo(() => {
    const names = SCHEDULED_ITEM_KINDS.filter((kind) => sourceErrors?.[kind] !== undefined).map(
      (kind) => t(`kindFilter.${kind}`)
    )
    if (names.length === 0) return ""
    try {
      return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(names)
    } catch {
      return names.join(", ")
    }
  }, [sourceErrors, t, locale])

  // Status dot color for the scheduler itself
  const schedulerDotClass =
    schedulerStatus === "running"
      ? "bg-green-500 animate-pulse"
      : schedulerStatus === "stopped"
        ? "bg-red-500"
        : "bg-gray-400"

  const { visibleItems, statusCounts, countsByKind, loopCount } = facets

  // Group the visible rows by kind for the collapsible sidebar sections.
  // Sources contributing nothing are skipped silently.
  const groupedByKind = useMemo(() => {
    const groups: Record<ScheduledItemKind, UnifiedScheduledItem[]> = {
      app: [],
      workflow: [],
      backup: [],
      plugin: [],
      system: [],
      connector: [],
    }
    for (const item of visibleItems) groups[item.kind].push(item)
    return groups
  }, [visibleItems])

  const hasNothingAtAll = items.length === 0
  const isFilteredEmpty = !hasNothingAtAll && visibleItems.length === 0
  const isNarrowed = visibleItems.length < items.length

  // O(1) membership lookups instead of Array#includes per row.
  const selectedUnifiedIdSet = useMemo(
    () => new Set(selectedUnifiedIds ?? []),
    [selectedUnifiedIds]
  )

  // Stable row-click dispatcher so `React.memo` on the row component holds.
  const handleItemClick = useCallback(
    (clickedItem: UnifiedScheduledItem) => onSelectItem(clickedItem),
    [onSelectItem]
  )

  return (
    <>
      {/* Header */}
      <SidebarHeader>
        <div className="flex items-center gap-2 px-3 py-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
          <Calendar className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="flex-1 text-sm font-semibold group-data-[collapsible=icon]:hidden">
            {t("title")}
          </span>
          <span
            data-testid="scheduler-status-dot"
            className={cn(
              "h-2 w-2 shrink-0 rounded-full group-data-[collapsible=icon]:hidden",
              schedulerDotClass
            )}
          />
          <Badge
            variant="outline"
            className="h-5 px-1.5 text-[10px] group-data-[collapsible=icon]:hidden"
            data-testid="scheduler-host"
          >
            {t(`host.${schedulerHost}`)}
          </Badge>
        </div>
      </SidebarHeader>

      {/* Search */}
      <div className="px-3 py-2 group-data-[collapsible=icon]:hidden">
        <InputGroup className="h-8">
          <InputGroupAddon align="inline-start">
            <Search aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            placeholder={t("searchTasks")}
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="text-sm"
            aria-label={t("searchTasks")}
          />
          {searchQuery && (
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                type="button"
                size="icon-xs"
                aria-label={t("clearSearch")}
                onClick={() => onSearchChange("")}
              >
                <X />
              </InputGroupButton>
            </InputGroupAddon>
          )}
        </InputGroup>
      </div>

      {/* One filter row: status segmented control + kind / loop menu. */}
      <div className="group-data-[collapsible=icon]:hidden">
        <SchedulerFilterBar
          status={statusFilter}
          onStatusChange={onStatusFilterChange}
          statusCounts={statusCounts}
          selectedKinds={selectedKinds}
          onToggleKind={onToggleKind}
          countsByKind={countsByKind}
          loopOnly={loopOnly}
          onLoopOnlyChange={onLoopOnlyChange}
          loopCount={loopCount}
          onClearKindFilters={onClearKindFilters}
        />
      </div>

      {/* Task list */}
      <SidebarContent className="group-data-[collapsible=icon]:hidden">
        {failedKinds && (
          <Surface
            layer="raised"
            radius="control"
            role="status"
            data-testid="scheduler-source-errors"
            className="mx-3 mb-2 flex items-start gap-2 border border-amber-500/30 px-2.5 py-2 text-[11px] text-amber-600 dark:text-amber-400"
          >
            <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{t("sourceLoadFailed", { kinds: failedKinds })}</span>
          </Surface>
        )}

        {hasNothingAtAll && <TaskListEmptyState onCreate={onCreate} />}

        {isFilteredEmpty && (
          <TaskListEmptyState variant="filtered" onClearFilters={onResetFilters} />
        )}

        {SCHEDULED_ITEM_KINDS.map((kind) => {
          const kindItems = groupedByKind[kind]
          if (kindItems.length === 0) return null
          return (
            <SidebarGroup key={kind}>
              <SidebarGroupLabel className="flex items-center gap-2">
                {t(`kindFilter.${kind}`)}
                <Badge variant="secondary" className="ml-auto text-[10px]">
                  {kindItems.length}
                </Badge>
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {kindItems.map((item) => (
                    <SidebarMenuItem key={item.unifiedId}>
                      <UnifiedTaskSidebarItem
                        item={item}
                        isActive={selectedUnifiedId === item.unifiedId}
                        isHighlighted={highlightedUnifiedId === item.unifiedId}
                        isSelected={selectedUnifiedIdSet.has(item.unifiedId)}
                        onToggleSelect={onToggleUnifiedSelection}
                        onClick={handleItemClick}
                        onRunNow={onRunNow}
                        onPause={onPause}
                        onResume={onResume}
                        onDelete={onDelete}
                      />
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          )
        })}
      </SidebarContent>

      {/*
        Footer. Deliberately NOT a second copy of the overview's active/paused/
        success-rate trio — that band is one pane away. What is genuinely only
        knowable here is how much the current filter is hiding, so the footer
        answers that and nothing else.
      */}
      <SidebarFooter className="group-data-[collapsible=icon]:hidden">
        <div
          className="flex items-center gap-x-3 gap-y-1 px-3 py-2 text-[11px] text-muted-foreground"
          data-testid="scheduler-sidebar-footer"
        >
          <span className="tabular-nums" data-testid="scheduler-sidebar-count">
            {isNarrowed
              ? t("sidebarFooter.filtered", { shown: visibleItems.length, total: items.length })
              : t("sidebarFooter.total", { total: items.length })}
          </span>
          {isNarrowed && (
            <button
              type="button"
              onClick={onResetFilters}
              className="ml-auto shrink-0 text-primary underline-offset-2 hover:underline"
              data-testid="scheduler-sidebar-reset-filters"
            >
              {t("filterBar.clear")}
            </button>
          )}
        </div>
      </SidebarFooter>
    </>
  )
}
