"use client"

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  AlertTriangle,
  Bug,
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
import {
  SettingsCard,
  SettingsEmptyState,
  SettingsGrid,
  SettingsGroup,
  SettingsPageHeader,
} from "@/components/settings/common/settings-section"
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

  const levelCounts = useMemo(() => {
    const counts = { fatal: 0, error: 0, warn: 0 }
    for (const item of items) {
      if (item.level === "fatal") counts.fatal++
      else if (item.level === "error") counts.error++
      else if (item.level === "warn") counts.warn++
    }
    return counts
  }, [items])

  return (
    <div className="space-y-4">
      {/* ─── Header with streamlined actions ─── */}
      <SettingsPageHeader
        title={t("crash.title")}
        description={t("crash.description")}
        icon={<Bug className="h-5 w-5" />}
        actions={
          <div className="flex items-center gap-2">
            {/* Refresh */}
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

            {/* Auto-refresh toggle */}
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

            {/* Export dropdown */}
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

            {/* Clear dropdown */}
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
          </div>
        }
      />

      {/* ─── Summary cards with level breakdown ─── */}
      <SettingsGrid columns={3}>
        {/* Total + level breakdown */}
        <SettingsCard
          title={t("crash.summary.total")}
          description={t("crash.summary.totalDescription")}
        >
          <div className="flex items-end justify-between gap-3">
            <div className="text-3xl font-bold tabular-nums">{summary.total}</div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              {levelCounts.fatal > 0 && (
                <span className="flex items-center gap-1">
                  <LevelDot level="fatal" /> {levelCounts.fatal} fatal
                </span>
              )}
              {levelCounts.error > 0 && (
                <span className="flex items-center gap-1">
                  <LevelDot level="error" /> {levelCounts.error} error
                </span>
              )}
              {levelCounts.warn > 0 && (
                <span className="flex items-center gap-1">
                  <LevelDot level="warn" /> {levelCounts.warn} warn
                </span>
              )}
            </div>
          </div>
          {/* Severity bar */}
          {summary.total > 0 && (
            <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted mt-2">
              {levelCounts.fatal > 0 && (
                <div
                  className="bg-red-600 transition-all"
                  style={{ width: `${(levelCounts.fatal / summary.total) * 100}%` }}
                />
              )}
              {levelCounts.error > 0 && (
                <div
                  className="bg-red-500 transition-all"
                  style={{ width: `${(levelCounts.error / summary.total) * 100}%` }}
                />
              )}
              {levelCounts.warn > 0 && (
                <div
                  className="bg-amber-500 transition-all"
                  style={{ width: `${(levelCounts.warn / summary.total) * 100}%` }}
                />
              )}
            </div>
          )}
        </SettingsCard>

        {/* By source */}
        <SettingsCard
          title={t("crash.summary.bySource")}
          description={t("crash.summary.bySourceDescription")}
        >
          <div className="flex items-center gap-4">
            <div className="space-y-1.5 flex-1">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{t("crash.sources.recent")}</span>
                <span className="font-semibold tabular-nums">{summary.bySource.recent}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{t("crash.sources.persisted")}</span>
                <span className="font-semibold tabular-nums">{summary.bySource.persisted}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{t("crash.sources.diagnostic")}</span>
                <span className="font-semibold tabular-nums">{summary.bySource.diagnostic}</span>
              </div>
            </div>
          </div>
        </SettingsCard>

        {/* Native status */}
        <SettingsCard
          title={t("crash.summary.native")}
          description={t("crash.summary.nativeDescription")}
        >
          <div className="flex items-center gap-3">
            <Circle
              className={cn(
                "h-4 w-4 fill-current",
                STATUS_COLOR[summary.nativeLoggingStatus] ?? STATUS_COLOR.unavailable
              )}
            />
            <span className="text-lg font-semibold capitalize">{summary.nativeLoggingStatus}</span>
          </div>
          {summary.nativeLoggingStatus !== "healthy" &&
            summary.nativeLoggingStatus !== "unavailable" && (
              <p className="text-xs text-muted-foreground mt-1">{t("crash.native.statusHint")}</p>
            )}
        </SettingsCard>
      </SettingsGrid>

      {/* ─── Main two-panel layout ─── */}
      <div className="grid gap-4 xl:grid-cols-[380px_minmax(0,1fr)]">
        {/* Left: log list */}
        <SettingsCard title={t("crash.listTitle")} description={t("crash.listDescription")}>
          <div className="space-y-3">
            {/* Status bar */}
            <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
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
              </span>
              <span>
                {lastUpdatedAt
                  ? new Date(lastUpdatedAt).toLocaleTimeString()
                  : t("crash.notAvailable")}
              </span>
            </div>

            {/* Filters */}
            <div className="grid gap-2 sm:grid-cols-2">
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

            {/* Error state */}
            {error ? (
              <div className="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                <div className="font-medium">{t("crash.errorTitle")}</div>
                <div className="text-xs mt-0.5">{error.message}</div>
              </div>
            ) : null}

            {/* Log list */}
            {isLoading ? (
              <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
                <RefreshCw className="h-4 w-4 animate-spin mr-2" />
                {t("crash.loading")}
              </div>
            ) : items.length === 0 ? (
              <SettingsEmptyState
                title={t("crash.emptyTitle")}
                description={t("crash.emptyDescription")}
              />
            ) : (
              <ScrollArea className="h-130">
                <div className="space-y-1.5 pr-2">
                  {items.map((item) => (
                    <CrashLogRow
                      key={item.id}
                      item={item}
                      selected={selectedItem?.id === item.id}
                      onSelect={() => selectItem(item.id)}
                    />
                  ))}
                </div>
              </ScrollArea>
            )}
          </div>
        </SettingsCard>

        {/* Right: detail panel */}
        <SettingsCard
          title={t("crash.detailTitle")}
          description={selectedItem ? selectedItem.title : t("crash.detailDescription")}
        >
          {!selectedItem ? (
            <SettingsEmptyState
              title={t("crash.noSelectionTitle")}
              description={t("crash.noSelectionDescription")}
            />
          ) : (
            <ScrollArea className="h-155">
              <div className="space-y-4 pr-2">
                {/* Header with inline actions */}
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-2 min-w-0 flex-1">
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
                    <div className="text-sm text-muted-foreground">{selectedItem.summary}</div>
                  </div>
                  {/* Contextual actions */}
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
                        >
                          <FolderOpen className="h-3.5 w-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t("crash.actions.openDirectory")}</TooltipContent>
                    </Tooltip>
                  </div>
                </div>

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
                      {selectedItem.diagnostics?.logDirectoryPath ?? t("crash.native.unavailable")}
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
          )}
        </SettingsCard>
      </div>

      {/* ─── Notes (collapsed by default) ─── */}
      <SettingsGroup
        title={t("crash.notes.title")}
        icon={<Info className="h-4 w-4" />}
        defaultOpen={false}
      >
        <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </SettingsGroup>
    </div>
  )
}
