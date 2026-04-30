"use client"

/**
 * SchedulerSidebar - Full sidebar for the task scheduler
 * Displays app tasks, system tasks, search, filters, and footer stats.
 */

import React from "react"
import { Calendar, Search, X, Circle } from "lucide-react"
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

import { FilterChips } from "./filter-chips"
import { TaskSidebarItem } from "./task-sidebar-item"

// ---------------------------------------------------------------------------
// System task status helpers
// ---------------------------------------------------------------------------

const systemStatusDot: Record<string, string> = {
  enabled: "bg-green-500",
  running: "bg-blue-500 animate-pulse",
  completed: "bg-green-400",
  failed: "bg-red-500",
  disabled: "bg-gray-400",
  unknown: "bg-gray-300",
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface SchedulerSidebarProps {
  tasks: ScheduledTask[]
  systemTasks: SystemTask[]
  selectedTaskId: string | null
  schedulerStatus: string // 'running' | 'stopped' | 'idle'
  statistics: TaskStatistics | null
  activeCount: number
  pausedCount: number
  searchQuery: string
  onSearchChange: (query: string) => void
  activeFilter: string
  onFilterChange: (filter: string) => void
  onSelectTask: (taskId: string) => void
  onSelectSystemTask?: (taskId: string) => void
  onRunNow: (taskId: string) => void
  onPause: (taskId: string) => void
  onResume: (taskId: string) => void
  onDelete: (taskId: string) => void
  highlightedIndex?: number
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SchedulerSidebar({
  tasks,
  systemTasks,
  selectedTaskId,
  schedulerStatus,
  statistics,
  activeCount,
  pausedCount,
  searchQuery,
  onSearchChange,
  activeFilter,
  onFilterChange,
  onSelectTask,
  onSelectSystemTask,
  onRunNow,
  onPause,
  onResume,
  onDelete,
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

  // Filter chips configuration
  const filters = [
    { key: "all", label: t("filter.all") || "All", count: tasks.length },
    {
      key: "active",
      label: t("statuses.active") || "Active",
      count: tasks.filter((task) => task.status === "active").length,
    },
    {
      key: "paused",
      label: t("statuses.paused") || "Paused",
      count: tasks.filter((task) => task.status === "paused").length,
    },
  ]

  // Footer success rate
  const successRate =
    statistics && statistics.totalExecutions > 0
      ? Math.round((statistics.successfulExecutions / statistics.totalExecutions) * 100)
      : 0

  return (
    <Sidebar collapsible="icon" className="border-r">
      {/* Header */}
      <SidebarHeader>
        <div className="flex items-center gap-2 px-3 py-2">
          <Calendar className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="flex-1 text-sm font-semibold">{t("title")}</span>
          <span
            data-testid="scheduler-status-dot"
            className={cn("h-2 w-2 shrink-0 rounded-full", schedulerDotClass)}
          />
        </div>
      </SidebarHeader>

      {/* Search */}
      <div className="px-3 py-2">
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

      {/* Filter chips */}
      <FilterChips filters={filters} activeFilter={activeFilter} onFilterChange={onFilterChange} />

      {/* Task lists */}
      <SidebarContent>
        {/* App Tasks */}
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

        {/* System Tasks (only when present) */}
        {systemTasks.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel className="flex items-center gap-2">
              {t("systemTasks")}
              <Badge variant="secondary" className="ml-auto text-[10px]">
                {systemTasks.length}
              </Badge>
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {systemTasks.map((st) => {
                  const dotCls = systemStatusDot[st.status] ?? "bg-gray-300"
                  return (
                    <SidebarMenuItem key={st.id}>
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => onSelectSystemTask?.(st.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") onSelectSystemTask?.(st.id)
                        }}
                        className="flex cursor-pointer items-center gap-2 px-3 py-2 transition-colors hover:bg-accent/50"
                      >
                        <Circle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate text-sm">{st.name}</span>
                        <span
                          data-testid={`system-status-dot-${st.id}`}
                          className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dotCls)}
                        />
                      </div>
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>

      {/* Footer stats */}
      <SidebarFooter>
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
    </Sidebar>
  )
}
