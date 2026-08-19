"use client"

/**
 * LogPanelToolbar
 *
 * Extracted from log-panel.tsx — 3-layer toolbar:
 *   Layer 1: Primary bar (view mode, search + regex, filters toggle, refresh, more)
 *   Layer 2: Level tabs (All, Error, Warn, Info, Debug, Trace, Bookmarked) + `statsSlot`
 *   Layer 3: Advanced filters — collapsible (module, source, session, time, presets, focus chips)
 *
 * Layer 1 used to be eight controls wide, five of them unlabelled icon
 * buttons, two of which had no accessible name at all (the view-mode toggles
 * carried a Tooltip but no `aria-label`, so their only name was an SVG). Three
 * things changed:
 *
 *   - the regex toggle moved inside the search field, where what it modifies
 *     is visible;
 *   - the keyboard-shortcuts button was deleted — it opened the same dialog as
 *     the More menu's "Keyboard shortcuts" item, which is still there;
 *   - auto-refresh got a real menu item. It was reachable only by shift-click
 *     or right-click on the refresh button, i.e. only if you had read the
 *     tooltip. The accelerators still work.
 *
 * Layer 2 absorbed the stats/pagination bar (`statsSlot`), which had been a
 * fourth full-width band restating the same per-level counts as the tabs.
 */

import { Fragment, memo, useCallback, useMemo, useRef, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { format } from "date-fns"
import type { DateRange } from "react-day-picker"
import {
  Search,
  Filter,
  Trash2,
  RefreshCw,
  Calendar as CalendarIcon,
  CalendarRange,
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
  Check,
  Link as LinkIcon,
  Rows3,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
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
import { AGENT_TRACE_MODULE } from "@cognia/agent-trace/log-adapter"
import type { LogLevel } from "@cognia/logging"
import type { LogFilterPreset, PresetTimeRange } from "@/types/logging"
import type { Density, ViewMode, PanelSource } from "@/hooks/logging/use-log-panel-filters"

export type ExportFormat = "json" | "csv" | "text" | "ndjson"

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

  // Custom time range (opens a Calendar popover when "Custom..." picked).
  customTimeRange: { start: Date; end: Date } | null
  setCustomTimeRange: (v: { start: Date; end: Date } | null) => void
  /** When true, the toolbar hides the preset Select so the host page can own it. */
  hideToolbarPresets?: boolean

  // Row density controls
  density: Density
  setDensity: (v: Density) => void

  /**
   * The stats / pagination line, rendered at the end of the level-filter row
   * rather than as a band of its own. Both rows were full-width and the counts
   * on this one duplicated the badges on the level tabs, so they are one row
   * now. `null` when the host hides stats.
   */
  statsSlot?: ReactNode
}

// Levels to show as tabs (fatal is merged into error)
const TAB_LEVELS: Array<LogLevel> = ["error", "warn", "info", "debug", "trace"]

/** The view-mode segment, as data — three near-identical Tooltip/Button pairs
 * before, which is how two of them ended up without an `aria-label`. */
const VIEW_MODES: ReadonlyArray<{
  value: ViewMode
  icon: typeof List
  labelKey: "panel.listView" | "panel.dashboardView" | "panel.traceView"
}> = [
  { value: "list", icon: List, labelKey: "panel.listView" },
  { value: "dashboard", icon: BarChart3, labelKey: "panel.dashboardView" },
  { value: "trace", icon: Activity, labelKey: "panel.traceView" },
]

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
  customTimeRange,
  setCustomTimeRange,
  hideToolbarPresets = false,
  density,
  setDensity,
  statsSlot = null,
}: LogPanelToolbarProps) {
  const t = useTranslations("logging")
  const [showSearchHistory, setShowSearchHistory] = useState(false)
  const [customRangeOpen, setCustomRangeOpen] = useState(false)
  const handleCopyShareUrl = useCallback(async () => {
    if (typeof window === "undefined") return
    const url = window.location.href
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url)
      } else {
        // Fallback for environments without async clipboard (older browsers / JSDOM).
        const ta = document.createElement("textarea")
        ta.value = url
        ta.setAttribute("readonly", "")
        ta.style.position = "absolute"
        ta.style.left = "-9999px"
        document.body.appendChild(ta)
        ta.select()
        document.execCommand("copy")
        document.body.removeChild(ta)
      }
      toast.success(t("panel.shareUrlCopied"))
    } catch {
      toast.error(t("panel.shareUrlFailed"))
    }
  }, [t])
  const [pendingRange, setPendingRange] = useState<DateRange | undefined>(() =>
    customTimeRange ? { from: customTimeRange.start, to: customTimeRange.end } : undefined
  )

  // Determine if any advanced filter is active
  const hasActiveAdvancedFilters =
    moduleFilter !== "all" ||
    sourceFilter !== "all" ||
    sessionFilter.trim() !== "" ||
    timeRange !== "all" ||
    customTimeRange !== null ||
    activePresetId !== EMPTY_PRESET_VALUE ||
    traceFocusId !== null ||
    hasSessionFocus ||
    diagnosticTransportFilter !== null

  const customRangeLabel = customTimeRange
    ? `${format(customTimeRange.start, "MMM d HH:mm")} → ${format(customTimeRange.end, "MMM d HH:mm")}`
    : null

  const errorFatalCount = (stats.byLevel["error"] || 0) + (stats.byLevel["fatal" as LogLevel] || 0)

  return (
    <div data-testid="log-panel-toolbar" className="border-b bg-muted/30">
      {/* ── Layer 1: Primary bar ── */}
      <div className="flex items-center gap-2 p-2 sm:p-3">
        {/* View mode toggle — a radio group in behaviour, so it says so:
            `aria-pressed` carries the selection and `aria-label` carries the
            name the tooltip used to be the only source of. */}
        <div
          className="flex shrink-0 items-center rounded-md border"
          role="group"
          aria-label={t("panel.viewModeGroup")}
        >
          {VIEW_MODES.filter((mode) => mode.value !== "trace" || includeAgentTrace).map((mode) => {
            const Icon = mode.icon
            const label = t(mode.labelKey)
            return (
              <Tooltip key={mode.value}>
                <TooltipTrigger asChild>
                  <Button
                    variant={viewMode === mode.value ? "default" : "ghost"}
                    size="sm"
                    className="h-8 px-2"
                    aria-label={label}
                    aria-pressed={viewMode === mode.value}
                    data-testid={`log-panel-view-${mode.value}`}
                    onClick={() => setViewMode(mode.value)}
                  >
                    <Icon className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{label}</TooltipContent>
              </Tooltip>
            )
          })}
        </div>

        {/* Search with accessible combobox-based history */}
        <SearchWithHistory
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          useRegex={useRegex}
          setUseRegex={setUseRegex}
          searchHistory={searchHistory}
          addSearchHistory={addSearchHistory}
          removeSearchHistoryItem={removeSearchHistoryItem}
          clearSearchHistory={clearSearchHistory}
          showSearchHistory={showSearchHistory}
          setShowSearchHistory={setShowSearchHistory}
          regexPlaceholder={t("panel.regexPlaceholder")}
          searchPlaceholder={t("panel.searchPlaceholder")}
        />

        {/* Advanced filters toggle */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={showAdvancedFilters ? "default" : "outline"}
              size="sm"
              className="relative h-8 px-2 shrink-0"
              aria-pressed={showAdvancedFilters}
              data-testid="log-panel-advanced-filters-toggle"
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

        {/* Refresh button */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={autoRefresh ? "default" : "outline"}
              size="sm"
              className="h-8 px-2 shrink-0"
              aria-label={autoRefresh ? t("panel.disableAutoRefresh") : t("panel.refresh")}
              data-testid="log-panel-refresh"
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
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-2 shrink-0"
              aria-label={t("panel.moreActions")}
              data-testid="log-panel-more-actions"
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuLabel>{t("panel.exportAs")}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => onExport("json")}>
                <FileJson className="h-4 w-4 mr-2" />
                {/* i18n-exempt: file-format name, not UI prose */}
                JSON
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onExport("csv")}>
                <FileSpreadsheet className="h-4 w-4 mr-2" />
                {/* i18n-exempt: file-format name, not UI prose */}
                CSV
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onExport("ndjson")}>
                <FileJson className="h-4 w-4 mr-2" />
                {/* i18n-exempt: file-format name, not UI prose */}
                NDJSON
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onExport("text")}>
                <FileText className="h-4 w-4 mr-2" />
                {t("panel.exportText")}
              </DropdownMenuItem>
              <DropdownMenuItem data-testid="log-panel-copy-share-url" onClick={handleCopyShareUrl}>
                <LinkIcon className="h-4 w-4 mr-2" />
                {t("panel.copyShareUrl")}
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => clearLogs()}>
                <Trash2 className="h-4 w-4 mr-2" />
                {t("panel.clear")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setShowDetailPanel(!showDetailPanel)}>
                <PanelRightClose className="h-4 w-4 mr-2" />
                {showDetailPanel ? t("panel.closeDetails") : t("panel.openDetailsPanel")}
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem
                data-testid="log-panel-auto-refresh-toggle"
                onClick={() => setAutoRefresh(!autoRefresh)}
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                <span className="flex-1">{t("panel.autoRefresh")}</span>
                {autoRefresh && <Check className="h-3.5 w-3.5" />}
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t("panel.scrollMenuLabel")}</DropdownMenuLabel>
            <DropdownMenuGroup>
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
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t("panel.densityMenuLabel")}</DropdownMenuLabel>
            <DropdownMenuGroup>
              {(["compact", "comfortable", "spacious"] as Density[]).map((d) => (
                <DropdownMenuItem
                  key={d}
                  data-testid={`log-panel-density-${d}`}
                  onClick={() => setDensity(d)}
                  className={cn(density === d && "bg-accent/40 font-medium")}
                >
                  <Rows3 className="h-4 w-4 mr-2" />
                  <span className="flex-1">{t(`panel.density.${d}`)}</span>
                  {density === d && <Check className="h-3.5 w-3.5" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => setShowShortcutsDialog(true)}>
                <Keyboard className="h-4 w-4 mr-2" />
                {t("panel.keyboardShortcuts")}
              </DropdownMenuItem>
            </DropdownMenuGroup>
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
        timeRange !== "all" ||
        customTimeRange !== null) && (
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
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => setSourceFilter("all")}
                className="ml-0.5 size-4 rounded p-0.5"
                aria-label={t("panel.filterChip.clearSource", { value: sourceFilter })}
              >
                <X className="h-3 w-3" />
              </Button>
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
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => setSessionFilter("")}
                className="ml-0.5 size-4 rounded p-0.5"
                aria-label={t("panel.filterChip.clearSession")}
              >
                <X className="h-3 w-3" />
              </Button>
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
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => setModuleFilter("all")}
                className="ml-0.5 size-4 rounded p-0.5"
                aria-label={t("panel.filterChip.clearModule")}
              >
                <X className="h-3 w-3" />
              </Button>
            </Badge>
          )}
          {timeRange !== "all" && (
            <Badge
              variant="secondary"
              data-testid="facet-chip-time"
              className="h-6 pl-2 pr-1 gap-1 text-xs font-normal"
            >
              <CalendarIcon className="h-3 w-3" />
              <span>{timeRange}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => setTimeRange("all")}
                className="ml-0.5 size-4 rounded p-0.5"
                aria-label={t("panel.filterChip.clearTimeRange")}
              >
                <X className="h-3 w-3" />
              </Button>
            </Badge>
          )}
          {customRangeLabel && (
            <Badge
              variant="secondary"
              data-testid="facet-chip-custom-time"
              className="h-6 pl-2 pr-1 gap-1 text-xs font-normal"
            >
              <CalendarRange className="h-3 w-3" />
              <span className="text-muted-foreground">{t("panel.customTimeRangeChipPrefix")}</span>
              <span>{customRangeLabel}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => {
                  setCustomTimeRange(null)
                  setPendingRange(undefined)
                }}
                className="ml-0.5 size-4 rounded p-0.5"
                aria-label={t("panel.customTimeRangeClear")}
              >
                <X className="h-3 w-3" />
              </Button>
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
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => setTraceFocusId(null)}
                className="ml-0.5 size-4 rounded p-0.5"
                aria-label={t("panel.filterChip.clearTrace")}
              >
                <X className="h-3 w-3" />
              </Button>
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
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => setDiagnosticTransportFilter(null)}
                className="ml-0.5 size-4 rounded p-0.5"
                aria-label={t("panel.filterChip.clearTransport")}
              >
                <X className="h-3 w-3" />
              </Button>
            </Badge>
          )}
        </div>
      )}

      {/* ── Layer 2: Level filters + stats/pagination ──
          One row, two halves. The level filters scroll horizontally when they
          run out of room rather than pushing the stats off-screen; below `md`
          the whole thing wraps and the stats take the second line. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 pb-2">
        <div
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          role="group"
          aria-label={t("panel.levelFilterGroup")}
        >
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

        {/* `shrink` (not `shrink-0`): the stats block wraps internally, and it
            can only do that if it is allowed to narrow. The level filters have
            a `0%` basis, so they yield space first and scroll instead. */}
        {statsSlot ? (
          <div className="ml-auto flex min-w-0 shrink items-center">{statsSlot}</div>
        ) : null}
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
              <SelectGroup>
                <SelectItem value="all">{t("panel.allModules")}</SelectItem>
                {augmentedModules.map((mod) => (
                  <SelectItem key={mod} value={mod}>
                    {mod === AGENT_TRACE_MODULE ? t("panel.agentTraceModule") : mod}
                  </SelectItem>
                ))}
              </SelectGroup>
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
              <SelectGroup>
                <SelectItem value="all">{t("panel.allSources")}</SelectItem>
                {allowedSources.map((source) => (
                  <SelectItem key={source} value={source}>
                    {t(`panel.sources.${source}`)}
                  </SelectItem>
                ))}
              </SelectGroup>
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

          {/* Time range selector — picking "custom" opens the calendar popover */}
          <Select
            value={customTimeRange ? "custom" : timeRange}
            onValueChange={(v) => {
              if (v === "custom") {
                setPendingRange(
                  customTimeRange
                    ? { from: customTimeRange.start, to: customTimeRange.end }
                    : undefined
                )
                setCustomRangeOpen(true)
                return
              }
              setCustomTimeRange(null)
              setTimeRange(v as PresetTimeRange)
            }}
          >
            <SelectTrigger
              className="h-8 w-full sm:w-[120px]"
              data-testid="log-panel-time-range-trigger"
            >
              <CalendarIcon className="h-3 w-3 sm:h-4 sm:w-4 mr-1" />
              <SelectValue placeholder={t("panel.timePlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">{t("panel.timeRangeAll")}</SelectItem>
                <SelectItem value="15m">{t("panel.timeRange15m")}</SelectItem>
                <SelectItem value="1h">{t("panel.timeRange1h")}</SelectItem>
                <SelectItem value="6h">{t("panel.timeRange6h")}</SelectItem>
                <SelectItem value="24h">{t("panel.timeRange24h")}</SelectItem>
                <SelectItem value="7d">{t("panel.timeRange7d")}</SelectItem>
                <SelectItem value="custom" data-testid="log-panel-time-range-custom">
                  {t("panel.customTimeRange")}
                </SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>

          {/* Custom range popover — also reachable directly via this trigger */}
          <Popover open={customRangeOpen} onOpenChange={setCustomRangeOpen}>
            <PopoverTrigger asChild>
              <Button
                variant={customTimeRange ? "default" : "outline"}
                size="sm"
                className="h-8 px-2"
                data-testid="log-panel-custom-range-trigger"
                aria-label={t("panel.customTimeRangePickerLabel")}
              >
                <CalendarRange className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              className="w-auto p-0"
              data-testid="log-panel-custom-range-popover"
            >
              <Calendar
                mode="range"
                numberOfMonths={2}
                selected={pendingRange}
                onSelect={setPendingRange}
                defaultMonth={pendingRange?.from ?? customTimeRange?.start ?? new Date()}
              />
              <div className="flex items-center justify-end gap-2 border-t p-2">
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="log-panel-custom-range-clear"
                  onClick={() => {
                    setPendingRange(undefined)
                    setCustomTimeRange(null)
                    setCustomRangeOpen(false)
                  }}
                >
                  {t("panel.customTimeRangeClear")}
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  data-testid="log-panel-custom-range-apply"
                  disabled={!pendingRange?.from || !pendingRange?.to}
                  onClick={() => {
                    if (pendingRange?.from && pendingRange?.to) {
                      setCustomTimeRange({ start: pendingRange.from, end: pendingRange.to })
                      setTimeRange("all")
                      setCustomRangeOpen(false)
                    }
                  }}
                >
                  {t("panel.customTimeRangeApply")}
                </Button>
              </div>
            </PopoverContent>
          </Popover>

          {/* Preset selector — hidden when host page owns presets */}
          {!hideToolbarPresets && (
            <Select value={activePresetId} onValueChange={handlePresetChange}>
              <SelectTrigger
                className="h-8 w-full sm:w-[150px]"
                data-testid="log-panel-preset-trigger"
              >
                <Bookmark className="h-3 w-3 sm:h-4 sm:w-4 mr-1" />
                <SelectValue placeholder={t("panel.presets")} />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value={EMPTY_PRESET_VALUE}>{t("panel.noPreset")}</SelectItem>
                  {presets.map((preset) => (
                    <SelectItem key={preset.id} value={preset.id}>
                      {preset.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          )}

          {/* Save preset */}
          {!hideToolbarPresets && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 px-2"
                  onClick={saveCurrentPreset}
                >
                  <BookmarkPlus className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("panel.savePreset")}</TooltipContent>
            </Tooltip>
          )}

          {/* Delete preset */}
          {!hideToolbarPresets && (
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
          )}

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
                ["/", t("panel.shortcuts.focusSearch")],
                ["b", t("panel.shortcuts.bookmarkEntry")],
                ["g", t("panel.shortcuts.openPresets")],
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
  setUseRegex: (value: boolean) => void
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
  setUseRegex,
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
        {/* Regex was a standalone button two slots to the right of the field it
            modified. Inside the field, its pressed state reads as a property of
            the query — which is what it is. */}
        <InputGroupAddon align="inline-end">
          <Tooltip>
            <TooltipTrigger asChild>
              <InputGroupButton
                variant={useRegex ? "default" : "ghost"}
                aria-label={t("panel.toggleRegex")}
                aria-pressed={useRegex}
                data-testid="log-panel-regex-toggle"
                onClick={() => setUseRegex(!useRegex)}
              >
                <Regex className="h-3.5 w-3.5" />
              </InputGroupButton>
            </TooltipTrigger>
            <TooltipContent>{t("panel.toggleRegex")}</TooltipContent>
          </Tooltip>
        </InputGroupAddon>
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
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      tabIndex={-1}
                      className="ml-2 shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
                      onMouseDown={(e) => {
                        e.preventDefault()
                        removeSearchHistoryItem(item)
                      }}
                      aria-label={t("panel.recentSearches.removeAria", { query: item })}
                    >
                      <X className="h-3 w-3" />
                    </Button>
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
