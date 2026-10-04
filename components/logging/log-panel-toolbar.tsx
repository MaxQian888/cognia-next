"use client"

/**
 * LogPanelToolbar
 *
 * Extracted from log-panel.tsx — 3-layer toolbar:
 *   Layer 1: Primary bar (view mode, search + regex, filters toggle, refresh, more)
 *   Layer 2: Level tabs (All, Error, Warn, Info, Debug, Trace, Bookmarked) + `statsSlot`
 *   Layer 3: Advanced filters — collapsible (module, source, session, time, presets)
 *   Facet chips: every active facet, with a "Clear all", directly above the list
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
 *   - live follow got a button of its own beside refresh. It was reachable
 *     only by shift-click or right-click on the refresh button (whose
 *     accessible name then contradicted what a plain click did), and later by
 *     a More-menu item; now each control does exactly what it is named.
 *
 * Transport health (`healthSlot`) sits beside Live / Refresh: whether entries
 * are being delivered is a property of the live stream those two control.
 *
 * Layer 2 absorbed the stats/pagination bar (`statsSlot`), which had been a
 * fourth full-width band restating the same per-level counts as the tabs.
 */

import { Fragment, memo, useCallback, useId, useRef, useState, type ReactNode } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { toast } from "sonner"
import { endOfDay, startOfDay } from "date-fns"
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
  FilterX,
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
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { AGENT_TRACE_MODULE } from "@cognia/agent-trace/log-adapter"
import type { LogLevel } from "@cognia/logging"
import type { LogFilterPreset, PresetTimeRange } from "@/types/logging"
import type { Density, ViewMode, PanelSource } from "@/hooks/logging/use-log-panel-filters"

export type ExportFormat = "json" | "csv" | "text" | "ndjson"

export interface LogPanelToolbarProps {
  // View mode
  viewMode: ViewMode
  setViewMode: (v: ViewMode | ((prev: ViewMode) => ViewMode)) => void
  /**
   * Whether the trace view has anything to group. It used to follow
   * `includeAgentTrace` alone, so a panel with agent spans switched off hid
   * the view even while every row carried a trace id.
   */
  traceViewAvailable: boolean

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

  // Stats — faceted: each level's count is what that tab would show with every
  // other active filter applied, so a badge and the rows under it agree.
  stats: { total: number; byLevel: Record<LogLevel, number> }

  // Presets
  presets: LogFilterPreset[]
  activePresetId: string
  handlePresetChange: (id: string) => void
  saveCurrentPreset: (name?: string) => void
  removeActivePreset: () => void
  EMPTY_PRESET_VALUE: string

  // Actions
  traceFocusId: string | null
  setTraceFocusId: (v: string | null) => void
  autoRefresh: boolean
  setAutoRefresh: (v: boolean) => void
  refresh: () => void
  onExport: (format: ExportFormat) => void
  clearLogs: () => void
  showDetailPanel: boolean
  setShowDetailPanel: (v: boolean) => void
  /** Whether there is a selected entry the detail pane could show. The menu
   * item that toggles the pane used to be live with nothing selected, and
   * "opened" a pane that the layout then refused to render. */
  canShowDetail?: boolean
  /** Resets every facet (level, module, source, session, time, search, trace,
   * transport, bookmarks) in one go — the chip row's "Clear all". */
  onClearAllFilters?: () => void

  // Scroll
  autoScroll: boolean
  setAutoScroll: (v: boolean) => void
  scrollToTop: () => void
  scrollToBottom: () => void
  /** Whether there is a list to scroll (list view, at least one row). The
   * scroll items are hidden otherwise rather than offered as no-ops. */
  scrollActionsAvailable?: boolean
  /** Whether auto-scroll can act: it follows new entries, so only while live
   * follow is on and the list is showing. */
  autoScrollAvailable?: boolean

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
  /** Delivery health (the transport chip), beside Live / Refresh in row one.
   * `null` when the host hides stats. */
  healthSlot?: ReactNode
}

/** How the custom-range chip prints each end. */
const CUSTOM_RANGE_FORMAT = {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
} as const

/** The time-range item that opens the calendar (see its `onValueChange`). */
const CUSTOM_RANGE_EDIT = "custom:edit"

// Levels to show as tabs (fatal is merged into error)
const TAB_LEVELS: Array<LogLevel> = ["error", "warn", "info", "debug", "trace"]

/** The time-range chip printed the raw preset key ("24h") next to chips that
 * all read in the user's language; it reuses the select's own labels now. */
const TIME_RANGE_LABEL_KEYS: Record<
  Exclude<PresetTimeRange, "all">,
  | "panel.timeRange15m"
  | "panel.timeRange1h"
  | "panel.timeRange6h"
  | "panel.timeRange24h"
  | "panel.timeRange7d"
> = {
  "15m": "panel.timeRange15m",
  "1h": "panel.timeRange1h",
  "6h": "panel.timeRange6h",
  "24h": "panel.timeRange24h",
  "7d": "panel.timeRange7d",
}

/** One active facet: optional icon, optional muted label, the value, and a ×. */
function FacetChip({
  testId,
  icon,
  label,
  value,
  title,
  mono = false,
  clearLabel,
  onClear,
}: {
  testId: string
  icon?: ReactNode
  label?: string
  value: string
  title?: string
  mono?: boolean
  clearLabel: string
  onClear: () => void
}) {
  return (
    <Badge
      variant="secondary"
      data-testid={testId}
      className="h-6 gap-1 pl-2 pr-1 text-xs font-normal"
      title={title}
    >
      {icon}
      {label ? <span className="text-muted-foreground">{label}</span> : null}
      <span className={cn("max-w-[160px] truncate", mono && "font-mono")}>{value}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={onClear}
        className="ml-0.5 size-4 rounded p-0.5"
        aria-label={clearLabel}
      >
        <X className="h-3 w-3" />
      </Button>
    </Badge>
  )
}

/**
 * Save-as-preset with a name. The button used to save immediately as
 * "Preset 1", "Preset 2" … — English on every locale, with no way to rename,
 * so a list of three presets could not be told apart without applying each.
 */
function SavePresetButton({
  defaultName,
  onSave,
}: {
  defaultName: string
  onSave: (name: string) => void
}) {
  const t = useTranslations("logging")
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(defaultName)

  const commit = () => {
    onSave(name.trim() || defaultName)
    setOpen(false)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setName(defaultName)
        setOpen(next)
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-2"
              aria-label={t("panel.savePreset")}
              data-testid="log-panel-save-preset"
            >
              <BookmarkPlus className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{t("panel.savePreset")}</TooltipContent>
      </Tooltip>
      <PopoverContent
        align="start"
        className="w-64 p-3"
        data-testid="log-panel-save-preset-popover"
      >
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            commit()
          }}
        >
          <label htmlFor="log-panel-preset-name" className="text-xs font-medium">
            {t("panel.presetNameLabel")}
          </label>
          <Input
            id="log-panel-preset-name"
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="h-8"
            data-testid="log-panel-preset-name"
          />
          <p className="text-[11px] text-muted-foreground">{t("panel.presetNameHint")}</p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
              {t("panel.presetCancel")}
            </Button>
            <Button type="submit" size="sm" data-testid="log-panel-save-preset-confirm">
              {t("panel.savePreset")}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  )
}

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
  traceViewAvailable,
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
  traceFocusId,
  setTraceFocusId,
  autoRefresh,
  setAutoRefresh,
  refresh,
  onExport,
  clearLogs,
  showDetailPanel,
  setShowDetailPanel,
  canShowDetail = true,
  onClearAllFilters,
  autoScroll,
  setAutoScroll,
  scrollToTop,
  scrollToBottom,
  scrollActionsAvailable = true,
  autoScrollAvailable = true,
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
  density,
  setDensity,
  statsSlot = null,
  healthSlot = null,
}: LogPanelToolbarProps) {
  const t = useTranslations("logging")
  const format = useFormatter()
  const [showSearchHistory, setShowSearchHistory] = useState(false)
  const [customRangeOpen, setCustomRangeOpen] = useState(false)
  const openingCustomRangeRef = useRef(false)
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

  /** Facets the chip row renders — one per chip, so "Clear all" only shows
   * when it would clear more than the single chip's own ×. */
  const activeFacetCount = [
    sourceFilter !== "all",
    sessionFilter.trim() !== "",
    moduleFilter !== "all",
    timeRange !== "all" && customTimeRange === null,
    customTimeRange !== null,
    traceFocusId !== null,
    diagnosticTransportFilter !== null,
  ].filter(Boolean).length

  // Determine if any advanced filter is active
  const hasActiveAdvancedFilters = activeFacetCount > 0 || activePresetId !== EMPTY_PRESET_VALUE

  // The app locale's month names and order; `date-fns/format` printed
  // "Jan 5 09:00" on every locale.
  const customRangeLabel = customTimeRange
    ? t("panel.customTimeRangeValue", {
        start: format.dateTime(customTimeRange.start, CUSTOM_RANGE_FORMAT),
        end: format.dateTime(customTimeRange.end, CUSTOM_RANGE_FORMAT),
      })
    : null

  const errorFatalCount = (stats.byLevel["error"] || 0) + (stats.byLevel["fatal" as LogLevel] || 0)

  return (
    <div data-testid="log-panel-toolbar" className="border-b bg-muted/30">
      {/* ── Layer 1: Primary bar ──
          Wraps. Six controls and a search field do not fit across 375px: the
          search was the only flexible item, so it absorbed the whole shortfall
          and its input measured 38px, about three characters, while every icon
          button beside it kept its full size. On a phone the search now takes
          a line of its own and the buttons share the next one. */}
      <div className="flex flex-wrap items-center gap-2 p-2 sm:p-3">
        {/* Search with accessible combobox-based history.
            First in the DOM, not second, because it is the one control that
            takes a whole row on a phone. Leaving it between the view toggle
            and the trailing buttons would have stranded the toggle alone on
            row one, or needed an `order` utility, which is how a toolbar ends
            up tabbing top row, bottom row, back to the top row. */}
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

        {/* View mode toggle — a radio group in behaviour, so it says so:
            `aria-pressed` carries the selection and `aria-label` carries the
            name the tooltip used to be the only source of. */}
        <div
          className="flex shrink-0 items-center rounded-md border"
          role="group"
          aria-label={t("panel.viewModeGroup")}
        >
          {VIEW_MODES.filter(
            // The active view always keeps its button, so a deep link to the
            // trace view still shows which view this is.
            (mode) => mode.value !== "trace" || traceViewAvailable || viewMode === "trace"
          ).map((mode) => {
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

        {/* Live follow and refresh are two controls. They used to be one
            button whose plain click refreshed while its accessible name — with
            follow on — said "Disable auto-refresh"; turning follow on or off
            took a shift-click, a right-click, or a trip into the More menu. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={autoRefresh ? "default" : "outline"}
              size="sm"
              className="h-8 shrink-0 gap-1.5 px-2"
              aria-pressed={autoRefresh}
              aria-label={autoRefresh ? t("panel.liveOnAria") : t("panel.liveOffAria")}
              data-testid="log-panel-auto-refresh-toggle"
              onClick={() => setAutoRefresh(!autoRefresh)}
            >
              {autoRefresh ? (
                <span aria-hidden className="relative flex size-2">
                  <span className="absolute inline-flex size-full rounded-full bg-current opacity-60 motion-safe:animate-ping" />
                  <span className="relative inline-flex size-2 rounded-full bg-current" />
                </span>
              ) : (
                <Play className="h-3.5 w-3.5" aria-hidden />
              )}
              <span className="hidden text-xs sm:inline">{t("panel.live")}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {autoRefresh ? t("panel.disableAutoRefresh") : t("panel.enableAutoRefresh")}
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-2 shrink-0"
              aria-label={t("panel.refresh")}
              data-testid="log-panel-refresh"
              onClick={() => refresh()}
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("panel.refresh")}</TooltipContent>
        </Tooltip>

        {healthSlot ? (
          <div className="flex shrink-0 items-center" data-testid="log-panel-health-slot">
            {healthSlot}
          </div>
        ) : null}

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
              <DropdownMenuItem
                data-testid="log-panel-toggle-detail"
                disabled={!showDetailPanel && !canShowDetail}
                onClick={() => setShowDetailPanel(!showDetailPanel)}
              >
                <PanelRightClose className="h-4 w-4 mr-2" />
                {showDetailPanel ? t("panel.closeDetails") : t("panel.openDetailsPanel")}
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                data-testid="log-panel-clear"
                onClick={() => clearLogs()}
              >
                <Trash2 className="h-4 w-4 mr-2" />
                {t("panel.clear")}
              </DropdownMenuItem>
            </DropdownMenuGroup>
            {/* Scroll items only where they can act: no list (dashboard,
                trace view, an empty result) means nothing to scroll, and
                auto-scroll follows new entries, which only arrive live. */}
            {scrollActionsAvailable || autoScrollAvailable ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>{t("panel.scrollMenuLabel")}</DropdownMenuLabel>
                <DropdownMenuGroup>
                  {scrollActionsAvailable ? (
                    <DropdownMenuItem onClick={scrollToTop} data-testid="log-panel-scroll-top">
                      <ChevronsUp className="h-4 w-4 mr-2" />
                      {t("panel.scrollToTop")}
                    </DropdownMenuItem>
                  ) : null}
                  {autoScrollAvailable ? (
                    <DropdownMenuItem
                      onClick={() => setAutoScroll(!autoScroll)}
                      data-testid="log-panel-auto-scroll"
                    >
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
                  ) : null}
                  {scrollActionsAvailable ? (
                    <DropdownMenuItem
                      onClick={scrollToBottom}
                      data-testid="log-panel-scroll-bottom"
                    >
                      <ChevronsDown className="h-4 w-4 mr-2" />
                      {t("panel.scrollToBottom")}
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuGroup>
              </>
            ) : null}
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

      {/* ── Layer 2: Level filters + stats/pagination ──
          One row, two halves. The filters size to their content (`flex-auto`),
          so when both halves do not fit the row wraps and the stats take the
          second line; the filters only scroll once they are alone on a line
          narrower than they are (a phone). With a `0%` basis the row never
          wrapped: a wide stats block crushed the filters to a 27px sliver
          showing "All" and nothing else, so Error/Warning/Info could not be
          reached until the stats text happened to get longer again. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 pb-2">
        {/* Below `sm` the tabs scroll sideways; the trailing edge fades so a
            phone shows there is more than "All · Error · Warning" — the cut
            used to fall cleanly between two buttons and read as the end. */}
        <div
          className="flex min-w-0 flex-auto items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden max-sm:pr-6 max-sm:[mask-image:linear-gradient(to_right,#000_calc(100%-2rem),transparent)]"
          data-edge-fade="true"
          role="group"
          data-testid="log-panel-level-filters"
          aria-label={t("panel.levelFilterGroup")}
        >
          {/* All tab */}
          <Button
            variant={levelFilter === "all" && !bookmarkFilterActive ? "default" : "ghost"}
            size="sm"
            className="h-7 px-2 shrink-0 gap-1 text-xs"
            aria-pressed={levelFilter === "all" && !bookmarkFilterActive}
            data-testid="log-panel-level-all"
            onClick={() => {
              setLevelFilter("all")
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
                aria-pressed={isActive}
                data-testid={`log-panel-level-${level}`}
                onClick={() => {
                  // The Error tab is error + fatal by itself; there is no
                  // separate high-severity flag to keep in step any more.
                  setLevelFilter(level)
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
            aria-pressed={bookmarkFilterActive}
            data-testid="log-panel-level-bookmarked"
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
            can only do that if it is allowed to narrow once it has a line of
            its own. */}
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
            <SelectTrigger
              className="h-8 w-full sm:w-[140px]"
              aria-label={t("panel.modulePlaceholder")}
              data-testid="log-panel-module-trigger"
            >
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
            <SelectTrigger
              className="h-8 w-full sm:w-[130px]"
              aria-label={t("panel.sourceFilterLabel")}
              data-testid="log-panel-source-trigger"
            >
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
              aria-label={t("panel.sessionPlaceholder")}
              value={sessionFilter}
              onChange={(e) => setSessionFilter(e.target.value)}
            />
          </InputGroup>

          {/* Time range — one control. Picking "Custom…" opens the calendar
              anchored to this select; there used to be a second calendar
              button beside it doing the same thing. */}
          <Popover open={customRangeOpen} onOpenChange={setCustomRangeOpen}>
            <PopoverAnchor asChild>
              <div className="w-full sm:w-auto">
                <Select
                  value={customTimeRange ? "custom" : timeRange}
                  onValueChange={(v) => {
                    // "Custom…" is an action, not a value: it opens the calendar
                    // whether or not a range is already set (selecting the current
                    // value fires nothing, so it could not have been the value).
                    if (v === CUSTOM_RANGE_EDIT) {
                      setPendingRange(
                        customTimeRange
                          ? { from: customTimeRange.start, to: customTimeRange.end }
                          : undefined
                      )
                      // Open once the select has finished closing: it hands focus
                      // back to its trigger as it goes, and a popover already open
                      // reads that as focus moving outside and dismisses itself.
                      openingCustomRangeRef.current = true
                      setTimeout(() => setCustomRangeOpen(true), 0)
                      return
                    }
                    setCustomTimeRange(null)
                    setTimeRange(v as PresetTimeRange)
                  }}
                >
                  <SelectTrigger
                    className="h-8 w-full sm:w-[120px]"
                    aria-label={t("panel.timePlaceholder")}
                    data-testid="log-panel-time-range-trigger"
                  >
                    <CalendarIcon className="h-3 w-3 sm:h-4 sm:w-4 mr-1" />
                    <SelectValue placeholder={t("panel.timePlaceholder")} />
                  </SelectTrigger>
                  <SelectContent
                    onCloseAutoFocus={(event) => {
                      // Leave focus for the calendar that is about to open.
                      if (openingCustomRangeRef.current) {
                        openingCustomRangeRef.current = false
                        event.preventDefault()
                      }
                    }}
                  >
                    <SelectGroup>
                      <SelectItem value="all">{t("panel.timeRangeAll")}</SelectItem>
                      <SelectItem value="15m">{t("panel.timeRange15m")}</SelectItem>
                      <SelectItem value="1h">{t("panel.timeRange1h")}</SelectItem>
                      <SelectItem value="6h">{t("panel.timeRange6h")}</SelectItem>
                      <SelectItem value="24h">{t("panel.timeRange24h")}</SelectItem>
                      <SelectItem value="7d">{t("panel.timeRange7d")}</SelectItem>
                      {customTimeRange ? (
                        <SelectItem value="custom">{t("panel.customTimeRangeActive")}</SelectItem>
                      ) : null}
                      <SelectItem
                        value={CUSTOM_RANGE_EDIT}
                        data-testid="log-panel-time-range-custom"
                      >
                        {t("panel.customTimeRange")}
                      </SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
            </PopoverAnchor>
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
                      // The calendar hands back midnights. Taken literally the
                      // range ended at 00:00 of its last day, so picking a
                      // single day matched nothing and a week lost its final
                      // day. Days are whole here; the timeline brush is the
                      // tool for sub-day ranges.
                      setCustomTimeRange({
                        start: startOfDay(pendingRange.from),
                        end: endOfDay(pendingRange.to),
                      })
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

          {/* Presets */}
          <Select value={activePresetId} onValueChange={handlePresetChange}>
            <SelectTrigger
              className="h-8 w-full sm:w-[150px]"
              aria-label={t("panel.presets")}
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

          <SavePresetButton
            defaultName={t("panel.presetDefaultName", { index: presets.length + 1 })}
            onSave={saveCurrentPreset}
          />

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-8 px-2"
                aria-label={t("panel.deletePreset")}
                data-testid="log-panel-delete-preset"
                onClick={removeActivePreset}
                disabled={activePresetId === EMPTY_PRESET_VALUE}
              >
                <BookmarkX className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("panel.deletePreset")}</TooltipContent>
          </Tooltip>
        </div>
      )}

      {/* ── Active facets ──
          One row, last before the list, so it reads as "what is narrowing the
          rows below". It used to sit between the search bar and the level row,
          and the advanced panel rendered the trace / session / transport
          facets a second time as "focus" buttons beside it. */}
      {activeFacetCount > 0 && (
        <div
          data-testid="log-panel-facet-chip-row"
          className="flex flex-wrap items-center gap-1.5 border-t border-border/40 px-2 py-2"
        >
          {sourceFilter !== "all" && (
            <FacetChip
              testId="facet-chip-source"
              label={t("panel.filterChip.sourceLabel")}
              value={t(`panel.sources.${sourceFilter}`)}
              clearLabel={t("panel.filterChip.clearSource", {
                value: t(`panel.sources.${sourceFilter}`),
              })}
              onClear={() => setSourceFilter("all")}
            />
          )}
          {sessionFilter.trim() !== "" && (
            <FacetChip
              testId="facet-chip-session"
              label={t("panel.filterChip.sessionLabel")}
              value={sessionFilter.trim()}
              mono
              clearLabel={t("panel.filterChip.clearSession")}
              onClear={() => setSessionFilter("")}
            />
          )}
          {moduleFilter !== "all" && (
            <FacetChip
              testId="facet-chip-module"
              label={t("panel.filterChip.moduleLabel")}
              value={
                moduleFilter === AGENT_TRACE_MODULE ? t("panel.agentTraceModule") : moduleFilter
              }
              clearLabel={t("panel.filterChip.clearModule")}
              onClear={() => setModuleFilter("all")}
            />
          )}
          {timeRange !== "all" && customTimeRange === null && (
            <FacetChip
              testId="facet-chip-time"
              icon={<CalendarIcon className="h-3 w-3" />}
              value={t(TIME_RANGE_LABEL_KEYS[timeRange])}
              clearLabel={t("panel.filterChip.clearTimeRange")}
              onClear={() => setTimeRange("all")}
            />
          )}
          {customRangeLabel && (
            <FacetChip
              testId="facet-chip-custom-time"
              icon={<CalendarRange className="h-3 w-3" />}
              label={t("panel.customTimeRangeChipPrefix")}
              value={customRangeLabel}
              clearLabel={t("panel.customTimeRangeClear")}
              onClear={() => {
                setCustomTimeRange(null)
                setPendingRange(undefined)
              }}
            />
          )}
          {traceFocusId && (
            <FacetChip
              testId="facet-chip-trace"
              icon={<Crosshair className="h-3 w-3" />}
              label={t("panel.filterChip.traceLabel")}
              value={traceFocusId.slice(0, 12)}
              title={traceFocusId}
              mono
              clearLabel={t("panel.filterChip.clearTrace")}
              onClear={() => setTraceFocusId(null)}
            />
          )}
          {diagnosticTransportFilter && (
            <FacetChip
              testId="facet-chip-transport"
              label={t("panel.filterChip.transportLabel")}
              value={diagnosticTransportFilter}
              clearLabel={t("panel.filterChip.clearTransport")}
              onClear={() => setDiagnosticTransportFilter(null)}
            />
          )}
          {onClearAllFilters && activeFacetCount > 1 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-xs text-muted-foreground"
              data-testid="log-panel-clear-all-filters"
              onClick={onClearAllFilters}
            >
              <FilterX className="h-3 w-3" />
              {t("panel.filterChip.clearAll")}
            </Button>
          )}
        </div>
      )}

      {/* Keyboard shortcuts dialog */}
      <Dialog open={showShortcutsDialog} onOpenChange={setShowShortcutsDialog}>
        <DialogContent className="max-w-sm sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("panel.keyboardShortcuts")}</DialogTitle>
            <DialogDescription>{t("panel.shortcutsDescription")}</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
            {(
              [
                ["r", t("panel.shortcuts.refresh")],
                ["d", t("panel.shortcuts.dashboardView")],
                ...(traceViewAvailable
                  ? ([["t", t("panel.shortcuts.traceView")]] as [string, string][])
                  : []),
                ["/", t("panel.shortcuts.focusSearch")],
                ["b", t("panel.shortcuts.bookmarkEntry")],
                ["g", t("panel.shortcuts.openPresets")],
                ["j / ↓", t("panel.shortcuts.nextEntry")],
                ["k / ↑", t("panel.shortcuts.previousEntry")],
                ["Enter / o", t("panel.shortcuts.openDetails")],
                ["e", t("panel.shortcuts.expandEntry")],
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

/**
 * The search field with its recent-search list, as a WAI-ARIA combobox.
 *
 * Focus never leaves the input. ArrowDown / ArrowUp move an active option
 * that the input points at through `aria-activedescendant`, Enter picks it,
 * Escape closes the list, Delete removes the active entry. The list used to
 * be a cmdk `Command` whose items took DOM focus on ArrowDown — which blurred
 * the input, so the screen reader left the field it was describing, and the
 * window-level `/` and `Esc` shortcuts started firing from inside the list.
 */
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
  const baseId = useId()
  const listboxId = `${baseId}-search-history`
  const optionId = (index: number) => `${baseId}-search-history-option-${index}`
  const [activeIndex, setActiveIndex] = useState(-1)
  const open = showSearchHistory && searchHistory.length > 0
  // The history can shrink under the cursor (remove / clear); clamp on read.
  const active = open && activeIndex >= 0 && activeIndex < searchHistory.length ? activeIndex : -1

  const close = () => {
    setShowSearchHistory(false)
    setActiveIndex(-1)
  }
  // Focus is already on the input — the keyboard never leaves it and the
  // list swallows pointer presses — so picking does not refocus it (which
  // would re-run `onFocus` against the not-yet-updated query and reopen).
  const pick = (query: string) => {
    setSearchQuery(query)
    close()
  }

  return (
    // The 12rem floor used to be a desktop-only assumption: with the view
    // toggle and the three trailing icon buttons it put the bar at ~458px, so
    // on a 375px screen "refresh" and "more actions" sat past the edge with
    // nothing to scroll them into view, and the field gave way instead, down
    // to a 38px input. The bar wraps now, so the overflow has somewhere to go
    // and the field can claim a row of its own rather than surrender one.
    <div className="relative w-full min-w-0 basis-full sm:w-auto sm:flex-1 sm:basis-auto sm:min-w-[12rem]">
      <InputGroup className="h-8">
        <InputGroupAddon>
          <Search className="h-4 w-4" />
        </InputGroupAddon>
        <InputGroupInput
          ref={inputRef}
          role="combobox"
          aria-label={useRegex ? regexPlaceholder : searchPlaceholder}
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? optionId(active) : undefined}
          placeholder={useRegex ? regexPlaceholder : searchPlaceholder}
          value={searchQuery}
          onChange={(e) => {
            setSearchQuery(e.target.value)
            setActiveIndex(-1)
          }}
          onFocus={() => {
            if (!searchQuery && searchHistory.length > 0) {
              setShowSearchHistory(true)
            }
          }}
          onBlur={(e) => {
            // A pointer press inside the list keeps the input focused (the
            // list prevents mousedown); anything else closes it.
            if (listRef.current?.contains(e.relatedTarget as Node | null)) {
              return
            }
            close()
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              if (searchHistory.length === 0) return
              e.preventDefault()
              if (!open) {
                setShowSearchHistory(true)
                setActiveIndex(e.key === "ArrowDown" ? 0 : searchHistory.length - 1)
                return
              }
              const step = e.key === "ArrowDown" ? 1 : -1
              const last = searchHistory.length - 1
              setActiveIndex(
                active < 0 ? (step > 0 ? 0 : last) : Math.min(Math.max(active + step, 0), last)
              )
            } else if (e.key === "Home" && active >= 0) {
              e.preventDefault()
              setActiveIndex(0)
            } else if (e.key === "End" && active >= 0) {
              e.preventDefault()
              setActiveIndex(searchHistory.length - 1)
            } else if (e.key === "Enter") {
              if (active >= 0) {
                e.preventDefault()
                pick(searchHistory[active])
              } else if (searchQuery.trim()) {
                addSearchHistory(searchQuery.trim())
                close()
              }
            } else if (e.key === "Delete" && active >= 0) {
              e.preventDefault()
              removeSearchHistoryItem(searchHistory[active])
            } else if (e.key === "Escape" && open) {
              // Closing the list is this Escape's whole job; the panel's
              // window-level Escape (clear search / close detail) must not
              // also run.
              e.preventDefault()
              close()
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

      {open && (
        <div
          ref={listRef}
          className="absolute top-full left-0 z-50 mt-1 w-full rounded-md border bg-popover shadow-md"
          data-testid="log-search-history-combobox"
          // Keep focus (and so the combobox) on the input while the pointer
          // works the list.
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="flex items-center justify-between px-2 py-1 border-b">
            <span className="text-xs text-muted-foreground" id={`${listboxId}-label`}>
              {t("panel.searchHistory")}
            </span>
            <Button
              variant="ghost"
              size="sm"
              tabIndex={-1}
              className="h-auto px-1.5 py-0.5 text-xs font-normal text-muted-foreground hover:text-foreground"
              onClick={() => {
                clearSearchHistory()
                close()
              }}
              data-testid="log-search-history-clear"
            >
              {t("panel.recentSearches.clear")}
            </Button>
          </div>
          <div
            id={listboxId}
            role="listbox"
            aria-labelledby={`${listboxId}-label`}
            className="max-h-60 overflow-y-auto p-1"
          >
            {searchHistory.map((item, index) => (
              <div
                key={item}
                id={optionId(index)}
                role="option"
                aria-selected={index === active}
                data-testid={`log-search-history-item-${item}`}
                data-active={index === active || undefined}
                className={cn(
                  "flex cursor-default items-center justify-between gap-2 rounded-sm px-2 py-1.5",
                  "hover:bg-accent/60",
                  index === active && "bg-accent text-accent-foreground"
                )}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => pick(item)}
              >
                <span className="flex-1 text-sm truncate">{item}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  tabIndex={-1}
                  className="ml-2 shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
                  onClick={(e) => {
                    e.stopPropagation()
                    removeSearchHistoryItem(item)
                  }}
                  aria-label={t("panel.recentSearches.removeAria", { query: item })}
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export const LogPanelToolbar = memo(LogPanelToolbarImpl)

export default LogPanelToolbar
