"use client"

/**
 * The `/logs` Diagnostics channel — local crash logs, their diagnostic
 * snapshot, and the export/clear controls that go with them.
 *
 * This surface used to live in Settings → Diagnostics → "Crash logs", which
 * meant the one page named after logs sent you to Settings to read the crash
 * ones, and the settings shell then had to host a full fill-height two-pane
 * inspector next to cards that toggle booleans. It is a channel here now, next
 * to `incidents` (native crash *reports* awaiting consent to upload) and
 * `service` (what a diagnostic service accepted from everyone) — three
 * different subjects, one workspace, no hop.
 *
 * The chrome is deliberately the sibling channels' chrome: a filter row, a
 * flat list that fills, and a resizable detail pane that becomes a sheet below
 * `xl`. What changed beyond the move:
 *
 *   - Severity no longer paints itself from the raw Tailwind palette
 *     (`bg-red-500`, `emerald-500`, `slate-400`). It goes through the same
 *     four tones the transport tiles use, so it follows the theme and the
 *     style pack instead of ignoring both.
 *   - The counts strip became the level filter. It was five numbers you could
 *     only read, sitting above a `<Select>` that did the filtering; the
 *     numbers are the control now and the select is gone.
 *   - The action row is one `ButtonGroup` of icons with labels that appear as
 *     the pane widens, rather than five labelled buttons that wrapped onto a
 *     second line in the width this pane actually gets.
 */

import { useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  AlertTriangleIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  FileTextIcon,
  FolderOpenIcon,
  InfoIcon,
  Loader2Icon,
  PackageIcon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  ScrollTextIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react"

import { LogDetailPanel } from "@/components/logging/log-detail-panel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ButtonGroup, ButtonGroupSeparator } from "@/components/ui/button-group"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useCrashLogs } from "@/hooks/logging/use-crash-logs"
import { useEdgeResize, useIsNarrow } from "@/hooks/ui"
import type {
  CrashLogItem,
  CrashLogLevelFilter,
  CrashLogSourceFilter,
} from "@/lib/logging/crash-log"
import { cn } from "@/lib/utils"
import {
  DETAIL_WIDTH_MAX,
  DETAIL_WIDTH_MIN,
  useLogWorkspaceStore,
} from "@/stores/logging/log-workspace-store"

/* ─── Tone vocabulary ───────────────────────────────────────────────────── */

/**
 * The same four tones `LogPanelStatsBar` paints transport tiles with. Severity
 * used to reach for `bg-red-600` / `bg-amber-500` / `bg-slate-300` directly,
 * which survives neither a theme swap nor a style pack (ADR-0148).
 */
type Tone = "danger" | "warning" | "info" | "success" | "muted"

const TONE_DOT: Record<Tone, string> = {
  danger: "bg-destructive",
  warning: "bg-warning",
  info: "bg-info",
  success: "bg-success",
  muted: "bg-muted-foreground/50",
}

const TONE_CHIP: Record<Tone, string> = {
  danger: "border-destructive/40 bg-destructive/5 text-destructive hover:bg-destructive/10",
  warning: "border-warning/40 bg-warning/5 text-warning hover:bg-warning/10",
  info: "border-info/40 bg-info/5 text-info hover:bg-info/10",
  success: "border-success/40 bg-success/5 text-success hover:bg-success/10",
  muted: "border-border bg-muted/30 text-muted-foreground hover:bg-muted/40",
}

const TONE_TEXT: Record<Tone, string> = {
  danger: "text-destructive",
  warning: "text-warning",
  info: "text-info",
  success: "text-success",
  muted: "text-muted-foreground",
}

const LEVEL_TONE: Record<string, Tone> = {
  fatal: "danger",
  error: "danger",
  warn: "warning",
  info: "info",
  debug: "muted",
  trace: "muted",
}

/** Readiness vocabulary of `NativeLoggingReadiness["status"]`, plus the
 * `"unavailable"` the summary substitutes when there is no native host. */
const NATIVE_TONE: Record<string, Tone> = {
  active: "success",
  healthy: "success",
  degraded: "warning",
  error: "danger",
  inactive: "muted",
  unavailable: "muted",
}

function levelTone(level: string): Tone {
  return LEVEL_TONE[level] ?? "muted"
}

/** Levels the counts strip offers as filters, worst first. */
const FILTER_LEVELS = ["fatal", "error", "warn"] as const

const SOURCE_OPTIONS: CrashLogSourceFilter[] = ["all", "recent", "persisted", "diagnostic"]

/* ─── Pieces ────────────────────────────────────────────────────────────── */

function LevelDot({ level, className }: { level: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[levelTone(level)], className)}
    />
  )
}

/**
 * A count that filters. Pressing it narrows to that level; pressing the active
 * one clears back to `all`, so the strip is also the way out of the filter it
 * applied.
 */
function LevelCountChip({
  level,
  count,
  active,
  label,
  onToggle,
}: {
  level: string
  count: number
  active: boolean
  label: string
  onToggle: () => void
}) {
  const tone = levelTone(level)
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      aria-label={label}
      data-testid={`crash-level-chip-${level}`}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-pill border px-2 py-0.5 text-[11px] transition-colors",
        TONE_CHIP[tone],
        active && "ring-1 ring-current/40"
      )}
    >
      <span aria-hidden className={cn("size-1.5 rounded-full", TONE_DOT[tone])} />
      <span className="font-mono tabular-nums">{count}</span>
      <span className="text-muted-foreground">{label}</span>
    </button>
  )
}

function CrashRow({
  item,
  selected,
  onSelect,
}: {
  item: CrashLogItem
  selected: boolean
  onSelect: () => void
}) {
  const t = useTranslations("logging")
  const tone = levelTone(item.level)

  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid="crash-row"
      data-selected={selected || undefined}
      className={cn(
        "group relative flex w-full min-w-0 flex-col gap-1 border-b px-3 py-2.5 text-left transition-colors",
        "hover:bg-muted/50 focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none",
        selected && "bg-muted"
      )}
    >
      {/* Severity reads as an edge, not as a fifth badge competing with the
          four already on the row. */}
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0 left-0 w-0.5",
          TONE_DOT[tone],
          !selected && "opacity-60 group-hover:opacity-100"
        )}
      />
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn("shrink-0 text-[10px] font-medium uppercase", TONE_TEXT[tone])}>
          {t(`levels.${item.level}`)}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{item.title}</span>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
          {new Date(item.timestamp).toLocaleTimeString()}
        </span>
      </div>
      {/* A recent-error item's summary is its message, which is also its title.
          Printing it twice reads as a rendering bug, not as detail. */}
      {item.summary && item.summary !== item.title ? (
        <div className="truncate text-xs text-muted-foreground">{item.summary}</div>
      ) : null}
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
        <Badge variant="outline" className="h-4 px-1 font-mono text-[10px]">
          {item.module}
        </Badge>
        {item.sources.map((source) => (
          <span key={source} className="rounded bg-muted px-1 py-px uppercase">
            {t(`crash.sources.${source}`)}
          </span>
        ))}
        {item.traceId ? <span className="max-w-40 truncate font-mono">{item.traceId}</span> : null}
      </div>
    </button>
  )
}

/** A labelled read-only value. Used for the two native-logging facts that are
 * worth reading without expanding the raw snapshot. */
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
    <div className="min-w-0 rounded-md border bg-muted/30 px-2.5 py-1.5">
      <div className="text-[10px] tracking-wide text-muted-foreground uppercase">{label}</div>
      <div className={cn("mt-0.5 text-sm", mono && "font-mono text-xs break-all")}>{children}</div>
    </div>
  )
}

/** Raw snapshot, collapsed. Nothing here is readable at a glance; it exists so
 * an exported bundle can be checked against what the app actually saw. */
function DiagnosticsJson({ title, data }: { title: string; data: unknown }) {
  const [open, setOpen] = useState(false)
  if (!data) return null

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-md border">
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          className="h-auto w-full justify-start gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium"
        >
          <ChevronRightIcon
            className={cn("size-3.5 transition-transform", open && "rotate-90")}
            aria-hidden
          />
          {title}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="mx-2.5 mb-2.5 overflow-x-auto rounded-md bg-muted/40 p-2.5 text-[11px] leading-relaxed">
          {JSON.stringify(data, null, 2)}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  )
}

function CrashDetail({
  item,
  relatedLogs,
  nativeStatus,
  busy,
  onCopy,
  onOpenDirectory,
}: {
  item: CrashLogItem
  relatedLogs: NonNullable<CrashLogItem["logEntry"]>[]
  nativeStatus: string
  busy: boolean
  onCopy: () => void
  onOpenDirectory: () => void
}) {
  const t = useTranslations("logging")
  const tone = levelTone(item.level)
  const status = item.diagnostics?.nativeLogging?.status ?? "unavailable"

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="crash-detail-pane">
      <header className="flex shrink-0 items-start gap-2 border-b p-3">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge
              variant="outline"
              className={cn("h-5 gap-1.5 px-1.5 text-[10px] uppercase", TONE_CHIP[tone])}
            >
              <LevelDot level={item.level} />
              {t(`levels.${item.level}`)}
            </Badge>
            <Badge variant="secondary" className="h-5 px-1.5 font-mono text-[10px]">
              {item.module}
            </Badge>
            {item.sources.map((source) => (
              <Badge key={source} variant="outline" className="h-5 px-1.5 text-[10px] uppercase">
                {t(`crash.sources.${source}`)}
              </Badge>
            ))}
          </div>
          <div className="text-sm font-medium">{item.title}</div>
          <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
            <span className="tabular-nums">{new Date(item.timestamp).toLocaleString()}</span>
            {item.traceId ? (
              <span className="font-mono">
                {t("panel.traceId")}: {item.traceId}
              </span>
            ) : null}
          </div>
        </div>
        <ButtonGroup className="shrink-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="size-8"
                onClick={onCopy}
                disabled={busy}
                aria-label={t("crash.actions.copySelected")}
              >
                <CopyIcon className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("crash.actions.copySelected")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="size-8"
                onClick={onOpenDirectory}
                disabled={!item.diagnostics?.logDirectoryPath && nativeStatus === "unavailable"}
                aria-label={t("crash.actions.openDirectory")}
              >
                <FolderOpenIcon className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("crash.actions.openDirectory")}</TooltipContent>
          </Tooltip>
        </ButtonGroup>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-3 p-3">
          {item.summary && item.summary !== item.title ? (
            <p className="text-sm text-muted-foreground">{item.summary}</p>
          ) : null}

          {item.logEntry ? <LogDetailPanel log={item.logEntry} relatedLogs={relatedLogs} /> : null}

          <section className="space-y-2 rounded-lg border p-3">
            <h3 className="flex items-center gap-2 text-sm font-medium">
              <ScrollTextIcon className="size-4 text-muted-foreground" aria-hidden />
              {t("crash.native.title")}
            </h3>
            <div className="grid gap-2 @[640px]/crash-detail:grid-cols-2">
              <DiagnosticsField label={t("crash.native.status")}>
                <span
                  className={cn(
                    "flex items-center gap-1.5",
                    TONE_TEXT[NATIVE_TONE[status] ?? "muted"]
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "size-1.5 rounded-full",
                      TONE_DOT[NATIVE_TONE[status] ?? "muted"]
                    )}
                  />
                  <span className="font-medium capitalize">{status}</span>
                </span>
              </DiagnosticsField>
              <DiagnosticsField label={t("crash.native.logDirectory")} mono>
                {item.diagnostics?.logDirectoryPath ?? t("crash.native.unavailable")}
              </DiagnosticsField>
            </div>
            <DiagnosticsJson
              title={t("crash.native.details")}
              data={item.diagnostics?.nativeLogging}
            />
          </section>

          {item.diagnostics?.windowDiagnostics || item.diagnostics?.localRuntimeDiagnostics ? (
            <section className="space-y-2 rounded-lg border p-3">
              <h3 className="flex items-center gap-2 text-sm font-medium">
                <AlertTriangleIcon className="size-4 text-muted-foreground" aria-hidden />
                {t("crash.diagnostics.title")}
              </h3>
              <DiagnosticsJson
                title={t("crash.diagnostics.window")}
                data={item.diagnostics?.windowDiagnostics}
              />
              <DiagnosticsJson
                title={t("crash.diagnostics.runtime")}
                data={item.diagnostics?.localRuntimeDiagnostics}
              />
            </section>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  )
}

/* ─── Channel ───────────────────────────────────────────────────────────── */

export function CrashDiagnosticsWorkspace() {
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

  // Shared with the Incidents channel on purpose: it is one workspace, and a
  // user who widened the detail pane there meant "detail panes are too narrow".
  const detailWidth = useLogWorkspaceStore((state) => state.detailWidth)
  const setDetailWidth = useLogWorkspaceStore((state) => state.setDetailWidth)
  const narrow = useIsNarrow()

  const [busy, setBusy] = useState(false)
  // `useCrashLogs` auto-selects a fallback item, so `selectedItem` alone cannot
  // say whether the user asked for the detail — the sheet needs its own flag.
  const [sheetOpen, setSheetOpen] = useState(false)

  const detailResize = useEdgeResize({
    width: detailWidth,
    min: DETAIL_WIDTH_MIN,
    max: DETAIL_WIDTH_MAX,
    edge: "left",
    onChange: setDetailWidth,
    onReset: () => setDetailWidth(384),
  })

  const run = useCallback(async (action: () => Promise<unknown> | unknown) => {
    setBusy(true)
    try {
      await action()
    } finally {
      setBusy(false)
    }
  }, [])

  const notes = useMemo(
    () => [
      t("crash.notes.paths"),
      t("crash.notes.runtime"),
      t("crash.notes.clear"),
      t("crash.notes.share"),
    ],
    [t]
  )

  const toggleLevel = useCallback(
    (level: CrashLogLevelFilter) => setLevelFilter(filters.level === level ? "all" : level),
    [filters.level, setLevelFilter]
  )

  const nativeTone = NATIVE_TONE[summary.nativeLoggingStatus] ?? "muted"

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden" data-testid="crash-diagnostics">
      <section className="flex min-w-0 flex-1 flex-col">
        {/* ── Filters + actions ── */}
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <InputGroup className="h-8 min-w-0 flex-1 basis-50">
            <InputGroupAddon>
              <SearchIcon className="size-4" />
            </InputGroupAddon>
            <InputGroupInput
              value={filters.search}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={t("crash.searchPlaceholder")}
              aria-label={t("crash.searchPlaceholder")}
            />
          </InputGroup>

          <Select
            value={filters.source}
            onValueChange={(value) => setSourceFilter(value as CrashLogSourceFilter)}
          >
            <SelectTrigger className="h-8 w-36" aria-label={t("crash.sourceLabel")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SOURCE_OPTIONS.map((option) => (
                <SelectItem key={option} value={option}>
                  {t(`crash.sources.${option}`)}
                  {option === "all" ? "" : ` (${summary.bySource[option]})`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <ButtonGroup className="ms-auto">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8"
                  onClick={() => void run(refresh)}
                  disabled={busy}
                  data-testid="crash-refresh"
                >
                  <RefreshCwIcon className={cn("size-4", isRefreshing && "animate-spin")} />
                  <span className="sr-only">{t("crash.actions.refresh")}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("crash.actions.refresh")}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8"
                  aria-pressed={autoRefresh}
                  onClick={() => setAutoRefresh(!autoRefresh)}
                  data-testid="crash-auto-refresh"
                >
                  {autoRefresh ? <PauseIcon className="size-4" /> : <PlayIcon className="size-4" />}
                  <span className="sr-only">
                    {autoRefresh
                      ? t("crash.actions.pauseRefresh")
                      : t("crash.actions.resumeRefresh")}
                  </span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {autoRefresh ? t("crash.actions.pauseRefresh") : t("crash.actions.resumeRefresh")}
              </TooltipContent>
            </Tooltip>
            <ButtonGroupSeparator />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8"
                  disabled={items.length === 0}
                  aria-label={t("crash.actions.export")}
                >
                  <DownloadIcon className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => exportBundle("bundle")}>
                  <PackageIcon className="size-4" />
                  {t("crash.actions.exportBundle")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => exportBundle("json")}>
                  <ScrollTextIcon className="size-4" />
                  {t("crash.actions.exportJson")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => exportBundle("text")}>
                  <FileTextIcon className="size-4" />
                  {t("crash.actions.exportText")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8"
                  disabled={busy}
                  aria-label={t("crash.actions.clear")}
                >
                  <Trash2Icon className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => clearRecent()}>
                  <RotateCcwIcon className="size-4" />
                  {t("crash.actions.clearRecent")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => void run(clearPersisted)}>
                  <Trash2Icon className="size-4" />
                  {t("crash.actions.clearPersisted")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8"
                  aria-label={t("crash.actions.notes")}
                >
                  <InfoIcon className="size-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-80">
                <div className="mb-2 text-sm font-medium">{t("crash.notes.title")}</div>
                <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                  {notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              </PopoverContent>
            </Popover>
          </ButtonGroup>
        </div>

        {/* ── Counts strip: the level filter, and the live state of the poll ── */}
        <div
          className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-3 py-2"
          data-testid="crash-summary-strip"
        >
          <span className="flex items-baseline gap-1.5 text-xs text-muted-foreground">
            <span className="font-mono text-base leading-none font-semibold text-foreground tabular-nums">
              {summary.total}
            </span>
            {t("crash.summary.total")}
          </span>
          <div className="flex flex-wrap items-center gap-1.5">
            {FILTER_LEVELS.filter(
              (level) => (summary.byLevel[level] ?? 0) > 0 || filters.level === level
            ).map((level) => (
              <LevelCountChip
                key={level}
                level={level}
                count={summary.byLevel[level] ?? 0}
                active={filters.level === level}
                label={t(`levels.${level}`)}
                onToggle={() => toggleLevel(level)}
              />
            ))}
          </div>
          <span className="ms-auto flex items-center gap-3 text-[11px] text-muted-foreground">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className={cn("flex items-center gap-1.5", TONE_TEXT[nativeTone])}>
                  <span aria-hidden className={cn("size-1.5 rounded-full", TONE_DOT[nativeTone])} />
                  <span className="capitalize">{summary.nativeLoggingStatus}</span>
                </span>
              </TooltipTrigger>
              <TooltipContent>{t("crash.summary.native")}</TooltipContent>
            </Tooltip>
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="relative flex size-1.5">
                {autoRefresh ? (
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-75" />
                ) : null}
                <span
                  className={cn(
                    "relative inline-flex size-1.5 rounded-full",
                    autoRefresh ? "bg-success" : "bg-muted-foreground/50"
                  )}
                />
              </span>
              <span className="tabular-nums">
                {autoRefresh ? t("crash.autoRefreshOn") : t("crash.autoRefreshOff")}
                {lastUpdatedAt ? ` · ${new Date(lastUpdatedAt).toLocaleTimeString()}` : ""}
              </span>
            </span>
          </span>
        </div>

        {/* ── List ── */}
        {error ? (
          <div className="border-b border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <div className="font-medium">{t("crash.errorTitle")}</div>
            <div className="mt-0.5 text-xs">{error.message}</div>
          </div>
        ) : null}

        {isLoading && items.length === 0 ? (
          <div className="flex flex-1 items-center justify-center gap-2 p-10 text-sm text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" />
            {t("crash.loading")}
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-1 items-center justify-center p-6">
            <Empty className="max-w-md border-y py-8" data-testid="crash-empty">
              <EmptyHeader>
                <EmptyTitle className="text-base">{t("crash.emptyTitle")}</EmptyTitle>
                <EmptyDescription>{t("crash.emptyDescription")}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <div className="min-w-0" data-testid="crash-list">
              {items.map((item) => (
                <CrashRow
                  key={item.id}
                  item={item}
                  selected={selectedItem?.id === item.id}
                  onSelect={() => {
                    selectItem(item.id)
                    setSheetOpen(true)
                  }}
                />
              ))}
            </div>
          </ScrollArea>
        )}
      </section>

      {/* ── Detail: a pane at xl, a sheet below it ── */}
      {selectedItem ? (
        <aside
          className="@container/crash-detail relative hidden shrink-0 border-l xl:block"
          style={{ width: detailWidth }}
        >
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t("crash.resizeDetail")}
            tabIndex={0}
            className={cn(
              "absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none",
              detailResize.dragging && "bg-primary/10"
            )}
            onPointerDown={detailResize.onPointerDown}
            onPointerMove={detailResize.onPointerMove}
            onPointerUp={detailResize.onPointerUp}
            onKeyDown={detailResize.onKeyDown}
            onDoubleClick={detailResize.onDoubleClick}
          />
          <CrashDetail
            key={selectedItem.id}
            item={selectedItem}
            relatedLogs={relatedLogs}
            nativeStatus={summary.nativeLoggingStatus}
            busy={busy}
            onCopy={() => void run(copySelected)}
            onOpenDirectory={() => void run(openNativeLogDirectory)}
          />
        </aside>
      ) : null}

      <Sheet open={sheetOpen && selectedItem !== null} onOpenChange={setSheetOpen}>
        <SheetContent
          side={narrow ? "bottom" : "right"}
          className={cn(
            "@container/crash-detail p-0 xl:hidden",
            narrow ? "h-dvh max-h-dvh" : "w-[min(92vw,560px)] sm:max-w-none"
          )}
          data-testid="crash-detail-drawer"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>{t("crash.detailTitle")}</SheetTitle>
            <SheetDescription>{t("crash.detailDescription")}</SheetDescription>
          </SheetHeader>
          {selectedItem ? (
            <CrashDetail
              key={selectedItem.id}
              item={selectedItem}
              relatedLogs={relatedLogs}
              nativeStatus={summary.nativeLoggingStatus}
              busy={busy}
              onCopy={() => void run(copySelected)}
              onOpenDirectory={() => void run(openNativeLogDirectory)}
            />
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  )
}

export default CrashDiagnosticsWorkspace
