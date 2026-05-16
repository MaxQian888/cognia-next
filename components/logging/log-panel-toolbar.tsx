"use client"

/**
 * LogPanelToolbar
 *
 * Extracted from log-panel.tsx — 3-layer toolbar:
 *   Layer 1: Primary bar (view mode, search, regex, filters toggle, refresh, more)
 *   Layer 2: Level tabs (All, Error, Warn, Info, Debug, Trace, Bookmarked)
 *   Layer 3: Advanced filters — collapsible (module, source, session, time, presets, focus chips)
 */

import { Fragment, memo, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  Search,
  Filter,
  Trash2,
  RefreshCw,
  Calendar,
  FileJson,
  FileText,
  FileSpreadsheet,
  BarChart3,
  List,
  Regex,
  Bookmark,
  BookmarkPlus,
  BookmarkX,
  Crosshair,
  Activity,
  PanelRightClose,
  ChevronsUp,
  ChevronsDown,
  Pause,
  Play,
  MoreHorizontal,
  X,
  Keyboard,
  BookmarkCheck,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { AGENT_TRACE_MODULE } from "@/lib/agent-trace/log-adapter"
import type { LogLevel } from "@/lib/logger"
import type { LogFilterPreset, PresetTimeRange } from "./log-filter-presets"
import type { ViewMode, PanelSource } from "@/hooks/logging/use-log-panel-filters"

export type ExportFormat = "json" | "csv" | "text"

export interface LogPanelToolbarProps {
  // View mode
  viewMode: ViewMode
  setViewMode: (v: ViewMode | ((prev: ViewMode) => ViewMode)) => void
  includeAgentTrace: boolean

  // Search
  searchQuery: string
  setSearchQuery: (v: string) => void
  useRegex: boolean
  setUseRegex: (v: boolean) => void

  // Filters
  levelFilter: LogLevel | "all"
  setLevelFilter: (v: LogLevel | "all") => void
  moduleFilter: string
  setModuleFilter: (v: string) => void
  augmentedModules: string[]
  sourceFilter: PanelSource | "all"
  setSourceFilter: (v: PanelSource | "all") => void
  allowedSources: PanelSource[]
  sessionFilter: string
  setSessionFilter: (v: string) => void
  timeRange: PresetTimeRange
  setTimeRange: (v: PresetTimeRange) => void

  // Stats
  stats: { total: number; byLevel: Record<LogLevel, number> }

  // Presets
  presets: LogFilterPreset[]
  activePresetId: string
  handlePresetChange: (id: string) => void
  saveCurrentPreset: () => void
  removeActivePreset: () => void
  EMPTY_PRESET_VALUE: string

  // Actions
  highSeverityOnly: boolean
  setHighSeverityOnly: (v: boolean | ((prev: boolean) => boolean)) => void
  traceFocusId: string | null
  setTraceFocusId: (v: string | null) => void
  autoRefresh: boolean
  setAutoRefresh: (v: boolean) => void
  refresh: () => void
  onExport: (format: ExportFormat) => void
  clearLogs: () => void
  showDetailPanel: boolean
  setShowDetailPanel: (v: boolean) => void

  // Scroll
  autoScroll: boolean
  setAutoScroll: (v: boolean) => void
  scrollToTop: () => void
  scrollToBottom: () => void

  // Session focus
  clearSessionFocus: () => void
  hasSessionFocus: boolean

  // New props
  bookmarkFilterActive: boolean
  setBookmarkFilterActive: (v: boolean) => void
  bookmarkedCount: number
  showAdvancedFilters: boolean
  setShowAdvancedFilters: (v: boolean) => void
  showShortcutsDialog: boolean
  setShowShortcutsDialog: (v: boolean) => void
  searchHistory: string[]
  addSearchHistory: (query: string) => void
  removeSearchHistoryItem: (query: string) => void
  clearSearchHistory: () => void
  diagnosticTransportFilter: string | null
  setDiagnosticTransportFilter: (v: string | null) => void
}

// Levels to show as tabs (fatal is merged into error)
const TAB_LEVELS: Array<LogLevel> = ["error", "warn", "info", "debug", "trace"]

function LogPanelToolbarImpl({
  viewMode,
  setViewMode,
  includeAgentTrace,
  searchQuery,
  setSearchQuery,
  useRegex,
  setUseRegex,
  levelFilter,
  setLevelFilter,
  moduleFilter,
  setModuleFilter,
  augmentedModules,
  sourceFilter,
  setSourceFilter,
  allowedSources,
  sessionFilter,
  setSessionFilter,
  timeRange,
  setTimeRange,
  stats,
  presets,
  activePresetId,
  handlePresetChange,
  saveCurrentPreset,
  removeActivePreset,
  EMPTY_PRESET_VALUE,
  highSeverityOnly,
  setHighSeverityOnly,
  traceFocusId,
  setTraceFocusId,
  autoRefresh,
  setAutoRefresh,
  refresh,
  onExport,
  clearLogs,
  showDetailPanel,
  setShowDetailPanel,
  autoScroll,
  setAutoScroll,
  scrollToTop,
  scrollToBottom,
  clearSessionFocus,
  hasSessionFocus,
  bookmarkFilterActive,
  setBookmarkFilterActive,
  bookmarkedCount,
  showAdvancedFilters,
  setShowAdvancedFilters,
  showShortcutsDialog,
  setShowShortcutsDialog,
  searchHistory,
  addSearchHistory,
  removeSearchHistoryItem,
  clearSearchHistory,
  diagnosticTransportFilter,
  setDiagnosticTransportFilter,
}: LogPanelToolbarProps) {
  const t = useTranslations("logging")
  const [showSearchHistory, setShowSearchHistory] = useState(false)

  // Determine if any advanced filter is active
  const hasActiveAdvancedFilters =
    moduleFilter !== "all" ||
    sourceFilter !== "all" ||
    sessionFilter.trim() !== "" ||
    timeRange !== "all" ||
    activePresetId !== EMPTY_PRESET_VALUE ||
    traceFocusId !== null ||
    hasSessionFocus ||
    diagnosticTransportFilter !== null

  const errorFatalCount = (stats.byLevel["error"] || 0) + (stats.byLevel["fatal" as LogLevel] || 0)

  return (
    <div data-testid="log-panel-toolbar" className="border-b bg-muted/30">
      {/* ── Layer 1: Primary bar ── */}
      <div className="flex items-center gap-2 p-2 sm:p-3">
        {/* View mode toggle */}
        <div className="flex items-center border rounded-md shrink-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={viewMode === "list" ? "default" : "ghost"}
                size="sm"
                className="h-8 px-2"
                onClick={() => setViewMode("list")}
              >
                <List className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("panel.listView")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={viewMode === "dashboard" ? "default" : "ghost"}
                size="sm"
                className="h-8 px-2"
                onClick={() => setViewMode("dashboard")}
              >
                <BarChart3 className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("panel.dashboardView")}</TooltipContent>
          </Tooltip>
          {includeAgentTrace && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={viewMode === "trace" ? "default" : "ghost"}
                  size="sm"
                  className="h-8 px-2"
                  onClick={() => setViewMode("trace")}
                >
                  <Activity className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("panel.traceView")}</TooltipContent>
            </Tooltip>
          )}
        </div>

        {/* Search with accessible combobox-based history */}
        <SearchWithHistory
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          useRegex={useRegex}
          searchHistory={searchHistory}
          addSearchHistory={addSearchHistory}
          removeSearchHistoryItem={removeSearchHistoryItem}
          clearSearchHistory={clearSearchHistory}
          showSearchHistory={showSearchHistory}
          setShowSearchHistory={setShowSearchHistory}
          regexPlaceholder={t("panel.regexPlaceholder")}
          searchPlaceholder={t("panel.searchPlaceholder")}
        />

        {/* Regex toggle */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={useRegex ? "default" : "outline"}
              size="sm"
              className="h-8 px-2 shrink-0"
              onClick={() => setUseRegex(!useRegex)}
            >
              <Regex className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("panel.toggleRegex")}</TooltipContent>
        </Tooltip>

        {/* Advanced filters toggle */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={showAdvancedFilters ? "default" : "outline"}
              size="sm"
              className="relative h-8 px-2 shrink-0"
              onClick={() => setShowAdvancedFilters(!showAdvancedFilters)}
              aria-label={
                showAdvancedFilters ? t("panel.moreFilters.hide") : t("panel.moreFilters.show")
              }
            >
              <Filter className="h-4 w-4" />
              {hasActiveAdvancedFilters && !showAdvancedFilters && (
                <span className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-primary" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {showAdvancedFilters ? t("panel.moreFilters.hide") : t("panel.moreFilters.show")}
          </TooltipContent>
        </Tooltip>

        {/* Keyboard shortcuts hint — visible in toolbar (was only in More menu) */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-2 shrink-0 hidden sm:inline-flex"
              onClick={() => setShowShortcutsDialog(true)}
              data-testid="log-toolbar-shortcut-hint"
              aria-label={t("panel.shortcutsHint")}
            >
              <Keyboard className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <div className="text-xs space-y-0.5">
              <div>
                <kbd className="font-mono">j/k</kbd> next/prev ·{" "}
                <kbd className="font-mono">Enter</kbd> expand
              </div>
              <div>
                <kbd className="font-mono">r</kbd> refresh · <kbd className="font-mono">?</kbd> all
                shortcuts
              </div>
            </div>
          </TooltipContent>
        </Tooltip>

        {/* Refresh button */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={autoRefresh ? "default" : "outline"}
              size="sm"
              className="h-8 px-2 shrink-0"
              onClick={(e) => {
                if (e.shiftKey) {
                  setAutoRefresh(!autoRefresh)
                } else {
                  refresh()
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                setAutoRefresh(!autoRefresh)
              }}
            >
              <RefreshCw className={cn("h-4 w-4", autoRefresh && "motion-safe:animate-spin")} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {autoRefresh ? t("panel.disableAutoRefresh") : t("panel.refresh")}
            <span className="block text-muted-foreground text-[10px]">
              {t("panel.shiftClickPrefix")}{" "}
              {autoRefresh ? t("panel.disableAutoRefresh") : t("panel.enableAutoRefresh")}
            </span>
          </TooltipContent>
        </Tooltip>

        {/* More actions dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-8 px-2 shrink-0">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuLabel>{t("panel.exportAs")}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onExport("json")}>
              <FileJson className="h-4 w-4 mr-2" />
              JSON
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onExport("csv")}>
              <FileSpreadsheet className="h-4 w-4 mr-2" />
              CSV
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onExport("text")}>
              <FileText className="h-4 w-4 mr-2" />
              {t("panel.exportText")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => clearLogs()}>
              <Trash2 className="h-4 w-4 mr-2" />
              {t("panel.clear")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setShowDetailPanel(!showDetailPanel)}>
              <PanelRightClose className="h-4 w-4 mr-2" />
              {showDetailPanel ? t("panel.closeDetails") : t("panel.openDetailsPanel")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t("panel.scrollMenuLabel")}</DropdownMenuLabel>
            <DropdownMenuItem onClick={scrollToTop}>
              <ChevronsUp className="h-4 w-4 mr-2" />
              {t("panel.scrollToTop")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setAutoScroll(!autoScroll)}>
              {autoScroll ? (
                <>
                  <Pause className="h-4 w-4 mr-2" />
                  {t("panel.pauseAutoScroll")}
                </>
              ) : (
                <>
                  <Play className="h-4 w-4 mr-2" />
                  {t("panel.resumeAutoScroll")}
                </>
              )}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={scrollToBottom}>
              <ChevronsDown className="h-4 w-4 mr-2" />
              {t("panel.scrollToBottom")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setShowShortcutsDialog(true)}>
              <Keyboard className="h-4 w-4 mr-2" />
              {t("panel.keyboardShortcuts")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* ── Facet chips — always visible when any facet is active ── */}
      {(sourceFilter !== "all" ||
        sessionFilter.trim() !== "" ||
        traceFocusId ||
        hasSessionFocus ||
        diagnosticTransportFilter ||
        moduleFilter !== "all" ||
        timeRange !== "all") && (
        <div
          data-testid="log-panel-facet-chip-row"
          className="flex flex-wrap items-center gap-1.5 px-2 pb-2 border-t border-border/40"
        >
          {sourceFilter !== "all" && (
            <Badge
              variant="secondary"
              data-testid="facet-chip-source"
              className="h-6 pl-2 pr-1 gap-1 text-xs font-normal"
            >
              <span className="text-muted-foreground">{t("panel.filterChip.sourceLabel")}</span>
              <span>{t(`panel.sources.${sourceFilter}`)}</span>
              <button
                type="button"
                onClick={() => setSourceFilter("all")}
                className="ml-0.5 rounded hover:bg-muted-foreground/10 p-0.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                aria-label={t("panel.filterChip.clearSource", { value: sourceFilter })}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          )}
          {sessionFilter.trim() !== "" && (
            <Badge
              variant="secondary"
              data-testid="facet-chip-session"
              className="h-6 pl-2 pr-1 gap-1 text-xs font-normal"
            >
              <span className="text-muted-foreground">{t("panel.filterChip.sessionLabel")}</span>
              <span className="font-mono truncate max-w-[120px]">{sessionFilter}</span>
              <button
                type="button"
                onClick={() => setSessionFilter("")}
                className="ml-0.5 rounded hover:bg-muted-foreground/10 p-0.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                aria-label={t("panel.filterChip.clearSession")}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          )}
          {moduleFilter !== "all" && (
            <Badge
              variant="secondary"
              data-testid="facet-chip-module"
              className="h-6 pl-2 pr-1 gap-1 text-xs font-normal"
            >
              <span className="text-muted-foreground">{t("panel.filterChip.moduleLabel")}</span>
              <span className="truncate max-w-[140px]">
                {moduleFilter === AGENT_TRACE_MODULE ? t("panel.agentTraceModule") : moduleFilter}
              </span>
              <button
                type="button"
                onClick={() => setModuleFilter("all")}
                className="ml-0.5 rounded hover:bg-muted-foreground/10 p-0.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                aria-label={t("panel.filterChip.clearModule")}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          )}
          {timeRange !== "all" && (
            <Badge
              variant="secondary"
              data-testid="facet-chip-time"
              className="h-6 pl-2 pr-1 gap-1 text-xs font-normal"
            >
              <Calendar className="h-3 w-3" />
              <span>{timeRange}</span>
              <button
                type="button"
                onClick={() => setTimeRange("all")}
                className="ml-0.5 rounded hover:bg-muted-foreground/10 p-0.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                aria-label={t("panel.filterChip.clearTimeRange")}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          )}
          {traceFocusId && (
            <Badge
              variant="secondary"
              data-testid="facet-chip-trace"
              className="h-6 pl-2 pr-1 gap-1 text-xs font-normal"
            >
              <Crosshair className="h-3 w-3" />
              <span>{t("panel.filterChip.traceLabel")}</span>
              <button
                type="button"
                onClick={() => setTraceFocusId(null)}
                className="ml-0.5 rounded hover:bg-muted-foreground/10 p-0.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                aria-label={t("panel.filterChip.clearTrace")}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          )}
          {diagnosticTransportFilter && (
            <Badge
              variant="secondary"
              data-testid="facet-chip-transport"
              className="h-6 pl-2 pr-1 gap-1 text-xs font-normal"
            >
              <span className="text-muted-foreground">{t("panel.filterChip.transportLabel")}</span>
              <span>{diagnosticTransportFilter}</span>
              <button
                type="button"
                onClick={() => setDiagnosticTransportFilter(null)}
                className="ml-0.5 rounded hover:bg-muted-foreground/10 p-0.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                aria-label={t("panel.filterChip.clearTransport")}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          )}
        </div>
      )}

      {/* ── Layer 2: Level tabs ── */}
      <div className="flex items-center gap-1 px-2 pb-2 overflow-x-auto">
        {/* All tab */}
        <Button
          variant={levelFilter === "all" && !bookmarkFilterActive ? "default" : "ghost"}
          size="sm"
          className="h-7 px-2 shrink-0 gap-1 text-xs"
          onClick={() => {
            setLevelFilter("all")
            setHighSeverityOnly(false)
            setBookmarkFilterActive(false)
          }}
        >
          {t("panel.allLevelsTab")}
          {stats.total > 0 && (
            <Badge variant="secondary" className="h-4 px-1 text-[10px]">
              {stats.total}
            </Badge>
          )}
        </Button>

        {/* Per-level tabs */}
        {TAB_LEVELS.map((level) => {
          const count = level === "error" ? errorFatalCount : stats.byLevel[level] || 0
          const isActive = levelFilter === level && !bookmarkFilterActive
          return (
            <Button
              key={level}
              variant={isActive ? "default" : "ghost"}
              size="sm"
              className="h-7 px-2 shrink-0 gap-1 text-xs capitalize"
              aria-pressed={level === "error" ? highSeverityOnly : undefined}
              onClick={() => {
                setLevelFilter(level)
                if (level === "error") {
                  setHighSeverityOnly(true)
                } else {
                  setHighSeverityOnly(false)
                }
                setBookmarkFilterActive(false)
              }}
            >
              {t(`levels.${level}`)}
              {count > 0 && (
                <Badge variant="secondary" className="h-4 px-1 text-[10px]">
                  {count}
                </Badge>
              )}
            </Button>
          )
        })}

        <div className="mx-1 h-5 w-px bg-border shrink-0" />

        {/* Bookmark tab */}
        <Button
          variant={bookmarkFilterActive ? "default" : "ghost"}
          size="sm"
          className="h-7 px-2 shrink-0 gap-1 text-xs"
          onClick={() => {
            if (bookmarkFilterActive) {
              setBookmarkFilterActive(false)
            } else {
              setBookmarkFilterActive(true)
              setLevelFilter("all")
            }
          }}
        >
          <BookmarkCheck className="h-3 w-3" />
          {t("panel.bookmarked")}
          {bookmarkedCount > 0 && (
            <Badge variant="secondary" className="h-4 px-1 text-[10px]">
              {bookmarkedCount}
            </Badge>
          )}
        </Button>
      </div>

      {/* ── Layer 3: Advanced filters (collapsible) ── */}
      {showAdvancedFilters && (
        <div
          data-testid="log-panel-filter-group"
          className="flex flex-wrap items-center gap-2 px-2 pb-2 pt-1 border-t border-border/50 motion-safe:animate-in motion-safe:slide-in-from-top-1 motion-safe:duration-150"
        >
          {/* Module selector */}
          <Select value={moduleFilter} onValueChange={setModuleFilter}>
            <SelectTrigger className="h-8 w-full sm:w-[140px]">
              <SelectValue placeholder={t("panel.modulePlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("panel.allModules")}</SelectItem>
              {augmentedModules.map((mod) => (
                <SelectItem key={mod} value={mod}>
                  {mod === AGENT_TRACE_MODULE ? t("panel.agentTraceModule") : mod}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Source selector */}
          <Select
            value={sourceFilter}
            onValueChange={(value) => setSourceFilter(value as PanelSource | "all")}
          >
            <SelectTrigger className="h-8 w-full sm:w-[130px]">
              <SelectValue placeholder={t("panel.allSources")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("panel.allSources")}</SelectItem>
              {allowedSources.map((source) => (
                <SelectItem key={source} value={source}>
                  {t(`panel.sources.${source}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Session filter */}
          <InputGroup className="h-8 w-full sm:w-[180px]">
            <InputGroupInput
              placeholder={t("panel.sessionPlaceholder")}
              value={sessionFilter}
              onChange={(e) => setSessionFilter(e.target.value)}
            />
          </InputGroup>

          {/* Time range selector */}
          <Select value={timeRange} onValueChange={(v) => setTimeRange(v as PresetTimeRange)}>
            <SelectTrigger className="h-8 w-full sm:w-[100px]">
              <Calendar className="h-3 w-3 sm:h-4 sm:w-4 mr-1" />
              <SelectValue placeholder={t("panel.timePlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("panel.timeRangeAll")}</SelectItem>
              <SelectItem value="15m">{t("panel.timeRange15m")}</SelectItem>
              <SelectItem value="1h">{t("panel.timeRange1h")}</SelectItem>
              <SelectItem value="6h">{t("panel.timeRange6h")}</SelectItem>
              <SelectItem value="24h">{t("panel.timeRange24h")}</SelectItem>
              <SelectItem value="7d">{t("panel.timeRange7d")}</SelectItem>
            </SelectContent>
          </Select>

          {/* Preset selector */}
          <Select value={activePresetId} onValueChange={handlePresetChange}>
            <SelectTrigger className="h-8 w-full sm:w-[150px]">
              <Bookmark className="h-3 w-3 sm:h-4 sm:w-4 mr-1" />
              <SelectValue placeholder={t("panel.presets")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={EMPTY_PRESET_VALUE}>{t("panel.noPreset")}</SelectItem>
              {presets.map((preset) => (
                <SelectItem key={preset.id} value={preset.id}>
                  {preset.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Save preset */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 px-2" onClick={saveCurrentPreset}>
                <BookmarkPlus className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("panel.savePreset")}</TooltipContent>
          </Tooltip>

          {/* Delete preset */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-8 px-2"
                onClick={removeActivePreset}
                disabled={activePresetId === EMPTY_PRESET_VALUE}
              >
                <BookmarkX className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("panel.deletePreset")}</TooltipContent>
          </Tooltip>

          {/* Active focus chips */}
          {traceFocusId && (
            <Button
              variant="secondary"
              size="sm"
              className="h-7 px-2 gap-1 text-xs"
              onClick={() => setTraceFocusId(null)}
            >
              <Crosshair className="h-3 w-3" />
              {t("panel.clearTraceFocus")}
              <X className="h-3 w-3" />
            </Button>
          )}

          {hasSessionFocus && (
            <Button
              variant="secondary"
              size="sm"
              className="h-7 px-2 gap-1 text-xs"
              onClick={clearSessionFocus}
            >
              <Filter className="h-3 w-3" />
              {t("panel.clearSessionFocus")}
              <X className="h-3 w-3" />
            </Button>
          )}

          {diagnosticTransportFilter && (
            <Button
              variant="secondary"
              size="sm"
              className="h-7 px-2 gap-1 text-xs"
              onClick={() => setDiagnosticTransportFilter(null)}
            >
              {t("panel.filterChip.transportPrefix", { name: diagnosticTransportFilter })}
              <X className="h-3 w-3" />
            </Button>
          )}
        </div>
      )}

      {/* Keyboard shortcuts dialog */}
      <Dialog open={showShortcutsDialog} onOpenChange={setShowShortcutsDialog}>
        <DialogContent className="max-w-sm sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("panel.keyboardShortcuts")}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
            {(
              [
                ["r", t("panel.shortcuts.refresh")],
                ["d", t("panel.shortcuts.dashboardView")],
                ["j / ↓", t("panel.shortcuts.nextEntry")],
                ["k / ↑", t("panel.shortcuts.previousEntry")],
                ["Enter", t("panel.shortcuts.expandEntry")],
                ["o", t("panel.shortcuts.openDetails")],
                ["Esc", t("panel.shortcuts.closeOrClear")],
                ["?", t("panel.shortcuts.showShortcuts")],
              ] as [string, string][]
            ).map(([key, action]) => (
              <Fragment key={key}>
                <kbd className="inline-flex items-center justify-center rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">
                  {key}
                </kbd>
                <span className="text-muted-foreground">{action}</span>
              </Fragment>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

interface SearchWithHistoryProps {
  searchQuery: string
  setSearchQuery: (value: string) => void
  useRegex: boolean
  searchHistory: string[]
  addSearchHistory: (value: string) => void
  removeSearchHistoryItem: (value: string) => void
  clearSearchHistory: () => void
  showSearchHistory: boolean
  setShowSearchHistory: (value: boolean) => void
  regexPlaceholder: string
  searchPlaceholder: string
}

function SearchWithHistory({
  searchQuery,
  setSearchQuery,
  useRegex,
  searchHistory,
  addSearchHistory,
  removeSearchHistoryItem,
  clearSearchHistory,
  showSearchHistory,
  setShowSearchHistory,
  regexPlaceholder,
  searchPlaceholder,
}: SearchWithHistoryProps) {
  const t = useTranslations("logging")
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const historyItems = useMemo(() => searchHistory, [searchHistory])

  return (
    <div className="relative min-w-[12rem] flex-1">
      <InputGroup className="h-8">
        <InputGroupAddon>
          <Search className="h-4 w-4" />
        </InputGroupAddon>
        <InputGroupInput
          ref={inputRef}
          role="combobox"
          aria-expanded={showSearchHistory}
          aria-controls="log-search-history-listbox"
          aria-autocomplete="list"
          placeholder={useRegex ? regexPlaceholder : searchPlaceholder}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onFocus={() => {
            if (!searchQuery && historyItems.length > 0) {
              setShowSearchHistory(true)
            }
          }}
          onBlur={(e) => {
            // Keep the dropdown open when focus moves into the listbox.
            if (listRef.current?.contains(e.relatedTarget as Node | null)) {
              return
            }
            setShowSearchHistory(false)
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && searchQuery.trim()) {
              addSearchHistory(searchQuery.trim())
              setShowSearchHistory(false)
            } else if (e.key === "Escape") {
              setShowSearchHistory(false)
            } else if (e.key === "ArrowDown" && showSearchHistory && historyItems.length > 0) {
              e.preventDefault()
              const firstItem = listRef.current?.querySelector(
                '[data-testid^="log-search-history-item-"]'
              ) as HTMLElement | null
              firstItem?.focus()
            }
          }}
          className={useRegex && searchQuery ? "font-mono text-xs" : ""}
        />
      </InputGroup>

      {showSearchHistory && historyItems.length > 0 && (
        <div
          ref={listRef}
          id="log-search-history-listbox"
          className="absolute top-full left-0 z-50 mt-1 w-full rounded-md border bg-popover shadow-md"
        >
          <Command
            shouldFilter={false}
            className="w-full"
            data-testid="log-search-history-combobox"
          >
            <div className="flex items-center justify-between px-2 py-1 border-b">
              <span className="text-xs text-muted-foreground">{t("panel.searchHistory")}</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-auto px-1.5 py-0.5 text-xs font-normal text-muted-foreground hover:text-foreground"
                onMouseDown={(e) => {
                  e.preventDefault()
                  clearSearchHistory()
                }}
                data-testid="log-search-history-clear"
              >
                {t("panel.recentSearches.clear")}
              </Button>
            </div>
            <CommandList className="max-h-60">
              <CommandEmpty>{t("panel.recentSearches.empty")}</CommandEmpty>
              <CommandGroup>
                {historyItems.map((item) => (
                  <CommandItem
                    key={item}
                    value={item}
                    data-testid={`log-search-history-item-${item}`}
                    className="flex items-center justify-between gap-2"
                    onSelect={(selected) => {
                      setSearchQuery(selected)
                      setShowSearchHistory(false)
                      inputRef.current?.focus()
                    }}
                  >
                    <span className="flex-1 text-sm truncate">{item}</span>
                    <button
                      type="button"
                      tabIndex={-1}
                      className="ml-2 text-muted-foreground hover:text-foreground shrink-0 rounded p-0.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      onMouseDown={(e) => {
                        e.preventDefault()
                        removeSearchHistoryItem(item)
                      }}
                      aria-label={t("panel.recentSearches.removeAria", { query: item })}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </div>
      )}
    </div>
  )
}

export const LogPanelToolbar = memo(LogPanelToolbarImpl)

export default LogPanelToolbar
