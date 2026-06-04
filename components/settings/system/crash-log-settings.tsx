"use client"

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  AlertTriangle,
  ArrowLeft,
  ChevronRight,
  Circle,
  Copy,
  Download,
  FileText,
  FolderOpen,
  Info,
  Package,
  PauseCircle,
  PlayCircle,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Trash2,
} from "lucide-react"

import { LogDetailPanel } from "@/components/logging/log-detail-panel"
import { SettingsEmptyState } from "@/components/settings/common/settings-section"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type {
  CrashLogItem,
  CrashLogLevelFilter,
  CrashLogSourceFilter,
} from "@/lib/logging/crash-log"
import { useCrashLogs } from "@/hooks/logging/use-crash-logs"

/* ─── Severity helpers ─── */

const LEVEL_COLOR: Record<string, string> = {
  fatal: "bg-red-600",
  error: "bg-red-500",
  warn: "bg-amber-500",
  info: "bg-blue-500",
  debug: "bg-slate-400",
  trace: "bg-slate-300",
}

const LEVEL_BORDER: Record<string, string> = {
  fatal: "border-l-red-600",
  error: "border-l-red-500",
  warn: "border-l-amber-500",
  info: "border-l-blue-500",
  debug: "border-l-slate-400",
  trace: "border-l-slate-300",
}

const STATUS_COLOR: Record<string, string> = {
  active: "text-emerald-500",
  healthy: "text-emerald-500",
  degraded: "text-amber-500",
  inactive: "text-slate-400",
  error: "text-red-500",
  unavailable: "text-slate-400",
}

/* ─── Sub-components ─── */

function SourceBadge({ source }: { source: CrashLogItem["sources"][number] }) {
  const t = useTranslations("logging")
  return (
    <Badge variant="secondary" className="text-[10px] uppercase tracking-wide">
      {t(`crash.sources.${source}`)}
    </Badge>
  )
}

function LevelDot({ level, className }: { level: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-block h-2 w-2 rounded-full shrink-0",
        LEVEL_COLOR[level] ?? "bg-slate-300",
        className
      )}
    />
  )
}

function CrashLogRow({
  item,
  selected,
  onSelect,
}: {
  item: CrashLogItem
  selected: boolean
  onSelect: () => void
}) {
  const t = useTranslations("logging")
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "w-full rounded-lg border border-l-[3px] px-3 py-2.5 text-left transition-colors hover:bg-muted/50",
        LEVEL_BORDER[item.level] ?? "border-l-slate-300",
        selected && "ring-1 ring-primary bg-muted/40"
      )}
    >
      <div className="space-y-1">
        <div className="flex items-center gap-1.5 flex-wrap">
          <Badge
            variant={item.level === "fatal" || item.level === "error" ? "destructive" : "outline"}
            className="text-[10px] uppercase"
          >
            {item.level}
          </Badge>
          <Badge variant="outline" className="text-[10px] font-mono">
            {item.module}
          </Badge>
          {item.sources.length > 1 && (
            <Badge variant="secondary" className="text-[10px]">
              {item.sources.length} {t("crash.sourceCount")}
            </Badge>
          )}
        </div>
        <div className="font-medium text-sm truncate">{item.title}</div>
        <div className="text-xs text-muted-foreground truncate">{item.summary}</div>
        <div className="text-[11px] text-muted-foreground flex items-center gap-2">
          <span>{new Date(item.timestamp).toLocaleString()}</span>
          {item.traceId ? (
            <span className="font-mono truncate max-w-30">{item.traceId}</span>
          ) : null}
        </div>
      </div>
    </button>
  )
}

function DiagnosticsField({
  label,
  children,
  mono,
}: {
  label: string
  children: React.ReactNode
  mono?: boolean
}) {
  return (
    <div className="rounded-md bg-muted/40 px-3 py-2">
      <div className="text-[11px] text-muted-foreground mb-0.5">{label}</div>
      <div className={cn("text-sm", mono && "font-mono text-xs break-all")}>{children}</div>
    </div>
  )
}

function DiagnosticsSection({
  title,
  data,
  defaultOpen = false,
}: {
  title: string
  data: unknown
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)

  if (!data) return null

  return (
    <div className="rounded-lg border">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 w-full px-3 py-2 text-sm font-medium hover:bg-muted/50 transition-colors"
      >
        <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} />
        {title}
      </button>
      {open && (
        <div className="px-3 pb-3">
          <pre className="overflow-x-auto rounded-md bg-muted/40 p-3 text-xs leading-relaxed">
            {JSON.stringify(data, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}

/* ─── Main component ─── */

export function CrashLogSettings() {
  const t = useTranslations("logging")
  const {
    isLoading,
    isRefreshing,
    error,
    autoRefresh,
    setAutoRefresh,
    lastUpdatedAt,
    filters,
    setSourceFilter,
    setLevelFilter,
    setSearchQuery,
    items,
    selectedItem,
    relatedLogs,
    selectItem,
    refresh,
    clearRecent,
    clearPersisted,
    copySelected,
    exportBundle,
    openNativeLogDirectory,
    summary,
  } = useCrashLogs()
  const [isBusy, setIsBusy] = useState(false)
  // The hook auto-selects a fallback item, so `selectedItem` alone cannot
  // drive the single-column (<md) list/detail switch — track it explicitly.
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false)

  const sourceOptions = useMemo<CrashLogSourceFilter[]>(
    () => ["all", "recent", "persisted", "diagnostic"],
    []
  )
  const levelOptions = useMemo<CrashLogLevelFilter[]>(() => ["all", "warn", "error", "fatal"], [])

  const notes = useMemo(
    () => [
      t("crash.notes.paths"),
      t("crash.notes.runtime"),
      t("crash.notes.clear"),
      t("crash.notes.share"),
    ],
    [t]
  )

  const handleAsyncAction = async (action: () => Promise<unknown> | unknown) => {
    setIsBusy(true)
    try {
      await action()
    } finally {
      setIsBusy(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3" data-testid="crash-log-settings">
      {/* ─── Compact toolbar: stats strip + actions ─── */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2">
        {/* Stats strip */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="flex items-baseline gap-1.5">
            <span className="text-lg font-bold tabular-nums text-foreground">{summary.total}</span>
            {t("crash.summary.total")}
          </span>
          {(["fatal", "error", "warn"] as const).map((level) =>
            summary.byLevel[level] > 0 ? (
              <span key={level} className="flex items-center gap-1">
                <LevelDot level={level} />
                <span className="tabular-nums">{summary.byLevel[level]}</span>
                {t(`levels.${level}`)}
              </span>
            ) : null
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex items-center gap-1.5">
                <Circle
                  className={cn(
                    "h-2.5 w-2.5 fill-current",
                    STATUS_COLOR[summary.nativeLoggingStatus] ?? STATUS_COLOR.unavailable
                  )}
                />
                <span className="capitalize">{summary.nativeLoggingStatus}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent>{t("crash.summary.native")}</TooltipContent>
          </Tooltip>
          <span className="flex items-center gap-1.5">
            {autoRefresh ? (
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
              </span>
            ) : (
              <span className="h-2 w-2 rounded-full bg-slate-400" />
            )}
            {autoRefresh ? t("crash.autoRefreshOn") : t("crash.autoRefreshOff")}
            <span>
              {lastUpdatedAt
                ? new Date(lastUpdatedAt).toLocaleTimeString()
                : t("crash.notAvailable")}
            </span>
          </span>
        </div>

        {/* Actions */}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleAsyncAction(refresh)}
                disabled={isBusy}
              >
                <RefreshCw className={cn("h-4 w-4", isRefreshing && "animate-spin")} />
                {t("crash.actions.refresh")}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("crash.actions.refresh")}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={autoRefresh ? "default" : "outline"}
                size="sm"
                onClick={() => setAutoRefresh(!autoRefresh)}
              >
                {autoRefresh ? (
                  <PauseCircle className="h-4 w-4" />
                ) : (
                  <PlayCircle className="h-4 w-4" />
                )}
                {autoRefresh ? t("crash.actions.pauseRefresh") : t("crash.actions.resumeRefresh")}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {autoRefresh ? t("crash.actions.pauseRefresh") : t("crash.actions.resumeRefresh")}
            </TooltipContent>
          </Tooltip>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" disabled={items.length === 0}>
                <Download className="h-4 w-4" />
                {t("crash.actions.export")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => exportBundle("bundle")}>
                <Package className="h-4 w-4 mr-2" />
                {t("crash.actions.exportBundle")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => exportBundle("json")}>
                <ScrollText className="h-4 w-4 mr-2" />
                {t("crash.actions.exportJson")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => exportBundle("text")}>
                <FileText className="h-4 w-4 mr-2" />
                {t("crash.actions.exportText")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" disabled={isBusy}>
                <Trash2 className="h-4 w-4" />
                {t("crash.actions.clear")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => clearRecent()}>
                <RotateCcw className="h-4 w-4 mr-2" />
                {t("crash.actions.clearRecent")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => void handleAsyncAction(clearPersisted)}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                {t("crash.actions.clearPersisted")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                aria-label={t("crash.actions.notes")}
              >
                <Info className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80">
              <div className="text-sm font-medium mb-2">{t("crash.notes.title")}</div>
              <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                {notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {/* ─── Fill-height two-pane layout ─── */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-[minmax(300px,360px)_1fr]">
        {/* Left: filters + log list */}
        <div
          data-testid="crash-list-pane"
          className={cn(
            "min-h-0 flex-col overflow-hidden rounded-lg border",
            mobileDetailOpen ? "hidden md:flex" : "flex"
          )}
        >
          <div className="shrink-0 space-y-2 border-b p-2">
            <div className="grid gap-2 grid-cols-2">
              <Select
                value={filters.source}
                onValueChange={(value) => setSourceFilter(value as CrashLogSourceFilter)}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {sourceOptions.map((option) => (
                    <SelectItem key={option} value={option}>
                      {t(`crash.sources.${option}`)}
                      {option !== "all" ? ` (${summary.bySource[option]})` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={filters.level}
                onValueChange={(value) => setLevelFilter(value as CrashLogLevelFilter)}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {levelOptions.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option === "all" ? t("crash.levels.all") : t(`levels.${option}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Input
              value={filters.search}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={t("crash.searchPlaceholder")}
              className="h-8 text-xs"
            />
          </div>

          {error ? (
            <div className="shrink-0 border-b border-destructive/50 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              <div className="font-medium">{t("crash.errorTitle")}</div>
              <div className="text-xs mt-0.5">{error.message}</div>
            </div>
          ) : null}

          {isLoading ? (
            <div className="flex flex-1 items-center justify-center py-12 text-sm text-muted-foreground">
              <RefreshCw className="h-4 w-4 animate-spin mr-2" />
              {t("crash.loading")}
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-1 items-center justify-center">
              <SettingsEmptyState
                title={t("crash.emptyTitle")}
                description={t("crash.emptyDescription")}
              />
            </div>
          ) : (
            <ScrollArea className="min-h-0 flex-1">
              <div className="space-y-1.5 p-2">
                {items.map((item) => (
                  <CrashLogRow
                    key={item.id}
                    item={item}
                    selected={selectedItem?.id === item.id}
                    onSelect={() => {
                      selectItem(item.id)
                      setMobileDetailOpen(true)
                    }}
                  />
                ))}
              </div>
            </ScrollArea>
          )}
        </div>

        {/* Right: detail panel */}
        <div
          data-testid="crash-detail-pane"
          className={cn(
            "min-h-0 flex-col overflow-hidden rounded-lg border",
            mobileDetailOpen ? "flex" : "hidden md:flex"
          )}
        >
          {!selectedItem ? (
            <div className="flex flex-1 items-center justify-center">
              <SettingsEmptyState
                title={t("crash.noSelectionTitle")}
                description={t("crash.noSelectionDescription")}
              />
            </div>
          ) : (
            <>
              {/* Detail header with inline actions */}
              <div className="flex shrink-0 items-start gap-2 border-b p-3">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0 md:hidden"
                  onClick={() => setMobileDetailOpen(false)}
                  aria-label={t("crash.actions.back")}
                >
                  <ArrowLeft className="h-4 w-4" />
                </Button>
                <div className="space-y-1.5 min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge
                      variant={
                        selectedItem.level === "fatal" || selectedItem.level === "error"
                          ? "destructive"
                          : "outline"
                      }
                      className="uppercase"
                    >
                      {selectedItem.level}
                    </Badge>
                    <Badge variant="outline">{selectedItem.module}</Badge>
                    {selectedItem.sources.map((source) => (
                      <SourceBadge key={`${selectedItem.id}-detail-${source}`} source={source} />
                    ))}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {new Date(selectedItem.timestamp).toLocaleString()}
                    {selectedItem.traceId && (
                      <span className="ml-2 font-mono">
                        {t("panel.traceId")}: {selectedItem.traceId}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() =>
                          void handleAsyncAction(() => Promise.resolve(copySelected()))
                        }
                        disabled={isBusy}
                        aria-label={t("crash.actions.copySelected")}
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t("crash.actions.copySelected")}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => void handleAsyncAction(openNativeLogDirectory)}
                        disabled={
                          !selectedItem?.diagnostics?.logDirectoryPath &&
                          summary.nativeLoggingStatus === "unavailable"
                        }
                        aria-label={t("crash.actions.openDirectory")}
                      >
                        <FolderOpen className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t("crash.actions.openDirectory")}</TooltipContent>
                  </Tooltip>
                </div>
              </div>

              <ScrollArea className="min-h-0 flex-1">
                <div className="space-y-4 p-3">
                  <div className="text-sm text-muted-foreground">{selectedItem.summary}</div>

                  {/* Log entry detail */}
                  {selectedItem.logEntry ? (
                    <LogDetailPanel log={selectedItem.logEntry} relatedLogs={relatedLogs} />
                  ) : null}

                  {/* Native logging diagnostics */}
                  <div className="space-y-2 rounded-lg border p-3">
                    <div className="flex items-center gap-2">
                      <Info className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm font-medium">{t("crash.native.title")}</span>
                    </div>
                    <div className="grid gap-2 md:grid-cols-2">
                      <DiagnosticsField label={t("crash.native.status")}>
                        <div className="flex items-center gap-2">
                          <Circle
                            className={cn(
                              "h-3 w-3 fill-current",
                              STATUS_COLOR[
                                selectedItem.diagnostics?.nativeLogging?.status ?? "unavailable"
                              ]
                            )}
                          />
                          <span className="font-medium capitalize">
                            {selectedItem.diagnostics?.nativeLogging?.status ??
                              t("crash.native.unavailable")}
                          </span>
                        </div>
                      </DiagnosticsField>
                      <DiagnosticsField label={t("crash.native.logDirectory")} mono>
                        {selectedItem.diagnostics?.logDirectoryPath ??
                          t("crash.native.unavailable")}
                      </DiagnosticsField>
                    </div>
                    {/* Detailed native logging info as collapsible */}
                    {selectedItem.diagnostics?.nativeLogging && (
                      <DiagnosticsSection
                        title={t("crash.native.details")}
                        data={selectedItem.diagnostics.nativeLogging}
                      />
                    )}
                  </div>

                  {/* Additional diagnostics */}
                  {(selectedItem.diagnostics?.windowDiagnostics ||
                    selectedItem.diagnostics?.localRuntimeDiagnostics) && (
                    <div className="space-y-2 rounded-lg border p-3">
                      <div className="flex items-center gap-2">
                        <AlertTriangle className="h-4 w-4 text-muted-foreground" />
                        <span className="text-sm font-medium">{t("crash.diagnostics.title")}</span>
                      </div>
                      <DiagnosticsSection
                        title={t("crash.diagnostics.window")}
                        data={selectedItem.diagnostics.windowDiagnostics}
                      />
                      <DiagnosticsSection
                        title={t("crash.diagnostics.runtime")}
                        data={selectedItem.diagnostics.localRuntimeDiagnostics}
                      />
                    </div>
                  )}
                </div>
              </ScrollArea>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
