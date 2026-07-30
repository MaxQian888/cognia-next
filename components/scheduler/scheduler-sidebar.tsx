"use client"

/**
 * SchedulerSidebar - Full sidebar for the task scheduler
 * Displays app tasks, system tasks, search, filters, and footer stats.
 */

import React, { useCallback, useMemo, useState } from "react"
import { Calendar, Search, X } from "lucide-react"
import { useTranslations } from "next-intl"

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
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import type { ScheduledTask, SystemTask, TaskStatistics } from "@/types/scheduler"
import {
  SCHEDULED_ITEM_KINDS,
  type ScheduledItemKind,
  type UnifiedScheduledItem,
} from "@/types/scheduler/unified"

import { FilterChips } from "./filter-chips"
import { TaskSidebarItem } from "./task-sidebar-item"
import { UnifiedTaskSidebarItem } from "./unified-task-sidebar-item"
import { KindFilterChips } from "./kind-filter-chips"
import { TaskListEmptyState } from "./empty-states"

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface SchedulerSidebarProps {
  tasks: ScheduledTask[]
  systemTasks: SystemTask[]
  /** Unified items merged across all sources (workflow/backup/plugin too). */
  unifiedItems?: UnifiedScheduledItem[]
  /** Counts per kind for the kind-filter chips. */
  countsByKind?: Record<ScheduledItemKind, number>
  selectedTaskId: string | null
  schedulerStatus: string // 'running' | 'stopped' | 'idle'
  schedulerHost?: "local" | "remote"
  statistics: TaskStatistics | null
  activeCount: number
  pausedCount: number
  searchQuery: string
  onSearchChange: (query: string) => void
  activeFilter: string
  onFilterChange: (filter: string) => void
  onSelectTask: (taskId: string) => void
  onSelectSystemTask?: (taskId: string) => void
  /** Click handler for any unified-source item (workflow/backup/plugin/system). */
  onSelectUnifiedItem?: (item: UnifiedScheduledItem) => void
  onRunNow: (taskId: string) => void
  onPause: (taskId: string) => void
  onResume: (taskId: string) => void
  onDelete: (taskId: string) => void
  /** Unified run / pause / resume / delete — dispatched per kind by the page. */
  onUnifiedRunNow?: (item: UnifiedScheduledItem) => void
  onUnifiedPause?: (item: UnifiedScheduledItem) => void
  onUnifiedResume?: (item: UnifiedScheduledItem) => void
  onUnifiedDelete?: (item: UnifiedScheduledItem) => void
  /** Multi-select: which unifiedIds are currently checked. */
  selectedUnifiedIds?: string[]
  /** Multi-select: toggle membership on a row. */
  onToggleUnifiedSelection?: (item: UnifiedScheduledItem) => void
  /** Empty-state CTA — opens the new-task sheet. */
  onCreate?: () => void
  highlightedIndex?: number
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
  tasks,
  systemTasks,
  unifiedItems,
  countsByKind,
  selectedTaskId,
  schedulerStatus,
  schedulerHost = "local",
  statistics,
  activeCount,
  pausedCount,
  searchQuery,
  onSearchChange,
  activeFilter,
  onFilterChange,
  onSelectTask,
  onSelectSystemTask,
  onSelectUnifiedItem,
  onRunNow,
  onPause,
  onResume,
  onDelete,
  onUnifiedRunNow,
  onUnifiedPause,
  onUnifiedResume,
  onUnifiedDelete,
  selectedUnifiedIds,
  onToggleUnifiedSelection,
  onCreate,
  highlightedIndex,
}: SchedulerSidebarProps) {
  const t = useTranslations("scheduler")

  // Status dot color for the scheduler itself
  const schedulerDotClass =
    schedulerStatus === "running"
      ? "bg-green-500 animate-pulse"
      : schedulerStatus === "stopped"
        ? "bg-red-500"
        : "bg-gray-400"

  // Filter chips configuration — one pass over the task list per render of
  // this memo instead of one filter() pass per chip.
  const filters = useMemo(() => {
    let active = 0
    let paused = 0
    let loop = 0
    for (const task of tasks) {
      if (task.status === "active") active++
      else if (task.status === "paused") paused++
      // /loop interval tasks (tagged by lib/loop/interval.ts).
      if (task.tags?.includes("loop")) loop++
    }
    return [
      { key: "all", label: t("filter.all") || "All", count: tasks.length },
      { key: "active", label: t("statuses.active") || "Active", count: active },
      { key: "paused", label: t("statuses.paused") || "Paused", count: paused },
      { key: "loop", label: t("filter.loop") || "Loop", count: loop },
    ]
  }, [tasks, t])

  // Footer success rate
  const successRate =
    statistics && statistics.totalExecutions > 0
      ? Math.round((statistics.successfulExecutions / statistics.totalExecutions) * 100)
      : 0

  // Kind filter — only when unified items are wired in. Default to "all kinds".
  const [selectedKinds, setSelectedKinds] = useState<Set<ScheduledItemKind>>(new Set())
  const filteredUnified = useMemo(() => {
    if (!unifiedItems) return undefined
    if (selectedKinds.size === 0) return unifiedItems
    return unifiedItems.filter((i) => selectedKinds.has(i.kind))
  }, [unifiedItems, selectedKinds])
  // Group unified items by kind for collapsible sidebar sections. Sources that
  // contribute zero items are skipped silently.
  const groupedUnified = useMemo(() => {
    if (!filteredUnified) return undefined
    const groups: Record<ScheduledItemKind, UnifiedScheduledItem[]> = {
      app: [],
      workflow: [],
      backup: [],
      plugin: [],
      system: [],
      connector: [],
    }
    for (const item of filteredUnified) groups[item.kind].push(item)
    return groups
  }, [filteredUnified])
  const showEmptyState =
    !!unifiedItems && unifiedItems.length === 0 && tasks.length === 0 && systemTasks.length === 0
  const showFilteredEmpty =
    !!unifiedItems && unifiedItems.length > 0 && filteredUnified && filteredUnified.length === 0

  // O(1) membership lookups instead of Array#includes per row.
  const selectedUnifiedIdSet = useMemo(
    () => new Set(selectedUnifiedIds ?? []),
    [selectedUnifiedIds]
  )

  // Stable row-click dispatcher so `React.memo` on the row components holds.
  const handleUnifiedItemClick = useCallback(
    (clickedItem: UnifiedScheduledItem) => {
      if (clickedItem.kind === "app") {
        onSelectTask(clickedItem.sourceId)
      } else if (clickedItem.kind === "system") {
        onSelectSystemTask?.(clickedItem.sourceId)
      } else {
        onSelectUnifiedItem?.(clickedItem)
      }
    },
    [onSelectTask, onSelectSystemTask, onSelectUnifiedItem]
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
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={t("searchTasks")}
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="h-8 pl-8 pr-7 text-sm"
            aria-label={t("searchTasks")}
          />
          {searchQuery && (
            <button
              type="button"
              aria-label={t("clearSearch")}
              onClick={() => onSearchChange("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Status filter chips */}
      <div className="group-data-[collapsible=icon]:hidden">
        <FilterChips
          filters={filters}
          activeFilter={activeFilter}
          onFilterChange={onFilterChange}
        />
      </div>

      {/* Kind filter chips (only when unified items are wired) */}
      {unifiedItems && countsByKind && (
        <div className="group-data-[collapsible=icon]:hidden">
          <KindFilterChips
            selected={selectedKinds}
            countsByKind={countsByKind}
            onToggle={(kind) => {
              setSelectedKinds((prev) => {
                const next = new Set(prev)
                if (next.has(kind)) next.delete(kind)
                else next.add(kind)
                return next
              })
            }}
            onClear={() => setSelectedKinds(new Set())}
          />
        </div>
      )}

      {/* Task lists */}
      <SidebarContent className="group-data-[collapsible=icon]:hidden">
        {showEmptyState && <TaskListEmptyState onCreate={onCreate} />}

        {showFilteredEmpty && (
          <TaskListEmptyState
            variant="filtered"
            onClearFilters={() => setSelectedKinds(new Set())}
          />
        )}

        {/* Unified groups by kind — preferred path when unified data is supplied. */}
        {groupedUnified && !showEmptyState && !showFilteredEmpty && (
          <>
            {SCHEDULED_ITEM_KINDS.map((kind) => {
              const items = groupedUnified[kind]
              if (items.length === 0) return null
              return (
                <SidebarGroup key={kind}>
                  <SidebarGroupLabel className="flex items-center gap-2">
                    {t(`kindFilter.${kind}`) || kind}
                    <Badge variant="secondary" className="ml-auto text-[10px]">
                      {items.length}
                    </Badge>
                  </SidebarGroupLabel>
                  <SidebarGroupContent>
                    <SidebarMenu>
                      {items.map((item, idx) => (
                        <SidebarMenuItem key={item.unifiedId}>
                          <UnifiedTaskSidebarItem
                            item={item}
                            isActive={item.kind === "app" && selectedTaskId === item.sourceId}
                            isHighlighted={item.kind === "app" && idx === highlightedIndex}
                            isSelected={selectedUnifiedIdSet.has(item.unifiedId)}
                            onToggleSelect={onToggleUnifiedSelection}
                            onClick={handleUnifiedItemClick}
                            onRunNow={onUnifiedRunNow}
                            onPause={onUnifiedPause}
                            onResume={onUnifiedResume}
                            onDelete={onUnifiedDelete}
                          />
                        </SidebarMenuItem>
                      ))}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>
              )
            })}
          </>
        )}

        {/* Legacy fallback — when unified items are NOT supplied, fall back to
            the original app + system split so the page still works for callers
            that haven't migrated yet. */}
        {!unifiedItems && (
          <>
            <SidebarGroup>
              <SidebarGroupLabel className="flex items-center gap-2">
                {t("appTasks")}
                <Badge variant="secondary" className="ml-auto text-[10px]">
                  {tasks.length}
                </Badge>
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {tasks.map((task, index) => (
                    <SidebarMenuItem key={task.id}>
                      <TaskSidebarItem
                        task={task}
                        isActive={selectedTaskId === task.id}
                        isHighlighted={index === highlightedIndex}
                        onClick={onSelectTask}
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
          </>
        )}
      </SidebarContent>

      {/* Footer stats */}
      <SidebarFooter className="group-data-[collapsible=icon]:hidden">
        <div className="grid grid-cols-3 gap-1 px-3 py-2 text-center">
          <div>
            <p className="text-[11px] font-semibold text-green-500">{activeCount}</p>
            <p className="text-[10px] text-muted-foreground">{t("statuses.active")}</p>
          </div>
          <div>
            <p className="text-[11px] font-semibold text-yellow-500">{pausedCount}</p>
            <p className="text-[10px] text-muted-foreground">{t("statuses.paused")}</p>
          </div>
          <div>
            <p className="text-[11px] font-semibold text-blue-500">{successRate}%</p>
            <p className="text-[10px] text-muted-foreground">{t("footerSuccess")}</p>
          </div>
        </div>
      </SidebarFooter>
    </>
  )
}
