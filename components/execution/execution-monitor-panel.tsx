"use client"

/**
 * Execution Monitor — single "what is running right now" surface ("围观").
 *
 * Renders the unified row list from {@link useExecutionMonitor} (broker legs +
 * active workflow runs + active scheduler executions) and lets the user cancel
 * any broker-governed leg (chat + every headless leg) individually or all at
 * once via {@link getExecutionBroker}. Workflow / scheduler rows are shown for
 * observability but are governed by their own subsystems, so they have no
 * cancel affordance here.
 *
 * The header exposes the view settings ("围观设置", {@link useExecutionMonitorPrefs}):
 * per-kind filtering, row sort, group-by-kind, and a live elapsed timer. Those
 * knobs are persisted on the settings singleton so the chosen view follows the
 * user across devices.
 */

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { Activity, Eye, RotateCcw, SlidersHorizontal, X } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/utils"
import { getExecutionBroker } from "@/lib/execution/broker"
import { promoteLegToPane } from "@/lib/execution/promote-to-pane"
import {
  EXECUTION_FILTER_KINDS,
  countExecutionRowsByKind,
  elapsedPartsFrom,
  type ExecutionFilterKind,
  type UnifiedExecutionRow,
  type UnifiedExecutionStatus,
} from "@/lib/execution/monitor-model"
import {
  applyExecutionMonitorPrefs,
  groupExecutionRowsByKind,
  EXECUTION_MONITOR_SORTS,
} from "@/lib/execution/monitor-prefs"
import { useExecutionMonitor } from "./use-execution-monitor"
import { useExecutionMonitorPrefs } from "@/hooks/execution/use-execution-monitor-prefs"

/**
 * Broker leg / filter kinds that map to a dedicated i18n label.
 *
 * The journal-only kinds are listed too. A row's `kind` is the RAW kind, not
 * the filter kind, so `agent-turn` / `plan` / `delegation` / `job` reach
 * `kindLabel` verbatim and would otherwise fall through to its raw-string
 * fallback — an untranslated internal identifier rendered to the user.
 */
const KIND_KEYS: Record<string, string> = {
  chat: "kind.chat",
  "workflow-step": "kind.workflowStep",
  scheduled: "kind.scheduled",
  connector: "kind.connector",
  subagent: "kind.subagent",
  goal: "kind.goal",
  team: "kind.team",
  workflow: "kind.workflow",
  "agent-turn": "kind.agentTurn",
  plan: "kind.plan",
  delegation: "kind.delegation",
  job: "kind.job",
  "security-scan": "kind.securityScan",
}

const STATUS_KEYS: Record<UnifiedExecutionStatus, string> = {
  queued: "status.queued",
  running: "status.running",
  waiting: "status.waiting",
  done: "status.done",
  error: "status.error",
  cancelled: "status.cancelled",
}

const STATUS_DOT: Record<UnifiedExecutionStatus, string> = {
  queued: "bg-muted-foreground/50",
  running: "bg-blue-500",
  waiting: "bg-yellow-500",
  done: "bg-green-500",
  error: "bg-red-500",
  cancelled: "bg-muted-foreground/40",
}

/** Statuses that keep ticking — only then do we run the 1s elapsed interval. */
const LIVE_STATUSES: ReadonlySet<UnifiedExecutionStatus> = new Set(["running", "queued", "waiting"])

export interface ExecutionMonitorPanelProps {
  /** Scope the monitor to a single workspace (unscoped rows are always shown). */
  projectId?: string
  className?: string
}

export function ExecutionMonitorPanel({ projectId, className }: ExecutionMonitorPanelProps) {
  const t = useTranslations("execution")
  const { rows } = useExecutionMonitor(projectId)
  const { prefs, toggleKind, setSort, setGroupByKind, setShowElapsed, isDefault, reset } =
    useExecutionMonitorPrefs()

  const kindLabel = (kind: string) => (KIND_KEYS[kind] ? t(KIND_KEYS[kind]) : kind)

  const kindCounts = useMemo(() => countExecutionRowsByKind(rows), [rows])
  const visibleRows = useMemo(() => applyExecutionMonitorPrefs(rows, prefs), [rows, prefs])
  const runningCount = useMemo(
    () => visibleRows.reduce((n, r) => (r.status === "running" ? n + 1 : n), 0),
    [visibleRows]
  )
  const hasCancellable = visibleRows.some((r) => r.cancellable)
  const hasActiveFilter = prefs.hiddenKinds.length > 0

  // Live elapsed clock: tick only while something is genuinely in-flight and the
  // timer is enabled, so an idle panel never re-renders on a timer. SSR-safe.
  const needsTick = prefs.showElapsed && visibleRows.some((r) => LIVE_STATUSES.has(r.status))
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!needsTick) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [needsTick])

  const cancelRow = (row: UnifiedExecutionRow) => {
    if (row.legId) getExecutionBroker().cancel(row.legId)
  }

  const renderRow = (row: UnifiedExecutionRow) => (
    <ExecutionRow
      key={row.rowId}
      row={row}
      kindLabel={kindLabel(row.kind)}
      statusLabel={
        // Say WHY it is queued. "Queued" alone reads as "hung", and only one
        // of the two reasons is something the user can act on: freeing a tree
        // means finishing or cancelling whatever is in it.
        row.status === "queued" && row.slotKey && !row.holdsSlot
          ? t("status.queuedOnSlot")
          : t(STATUS_KEYS[row.status])
      }
      elapsed={prefs.showElapsed ? formatElapsed(t, row.startedAt, now) : null}
      watchAria={t("watchLeg", { label: row.label })}
      cancelAria={t("cancelLeg", { label: row.label })}
      onWatch={() => void promoteLegToPane(row.sessionId!)}
      onCancel={() => cancelRow(row)}
    />
  )

  return (
    <Card className={cn("border-border/50 bg-card/80", className)} data-testid="execution-monitor">
      <CardContent className="p-4">
        <div className="mb-3 flex items-center gap-2">
          <Activity className="h-4 w-4 text-blue-500" aria-hidden="true" />
          <h3 className="text-sm font-semibold">{t("title")}</h3>
          <span className="text-xs text-muted-foreground tabular-nums">
            {t("runningCount", { count: runningCount })}
          </span>
          <div className="ml-auto flex items-center gap-1">
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="relative h-7 w-7 text-muted-foreground hover:text-foreground"
                  aria-label={t("controls.label")}
                >
                  <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
                  {hasActiveFilter && (
                    <span
                      className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-blue-500"
                      aria-hidden="true"
                    />
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-72 space-y-4">
                <MonitorControls
                  prefs={prefs}
                  kindCounts={kindCounts}
                  kindLabel={kindLabel}
                  isDefault={isDefault}
                  onToggleKind={toggleKind}
                  onSetSort={setSort}
                  onSetGroupByKind={setGroupByKind}
                  onSetShowElapsed={setShowElapsed}
                  onReset={reset}
                  t={t}
                />
              </PopoverContent>
            </Popover>
            {hasCancellable && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs"
                onClick={() => getExecutionBroker().cancelAll()}
              >
                {t("cancelAll")}
              </Button>
            )}
          </div>
        </div>

        {rows.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">{t("empty")}</p>
        ) : visibleRows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-4">
            <p className="text-center text-xs text-muted-foreground">{t("filteredEmpty")}</p>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => void reset()}
            >
              {t("clearFilters")}
            </Button>
          </div>
        ) : prefs.groupByKind ? (
          <div className="space-y-3">
            {groupExecutionRowsByKind(visibleRows).map((group) => (
              <section key={group.kind} aria-label={kindLabel(group.kind)}>
                <div className="mb-1 flex items-center gap-2 px-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {kindLabel(group.kind)}
                  </span>
                  <span className="text-[10px] text-muted-foreground tabular-nums">
                    {group.rows.length}
                  </span>
                </div>
                <ul role="list" aria-label={kindLabel(group.kind)} className="space-y-0.5">
                  {group.rows.map(renderRow)}
                </ul>
              </section>
            ))}
          </div>
        ) : (
          <ul role="list" aria-label={t("title")} className="space-y-0.5">
            {visibleRows.map(renderRow)}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

interface ExecutionRowProps {
  row: UnifiedExecutionRow
  kindLabel: string
  statusLabel: string
  elapsed: string | null
  watchAria: string
  cancelAria: string
  onWatch: () => void
  onCancel: () => void
}

function ExecutionRow({
  row,
  kindLabel,
  statusLabel,
  elapsed,
  watchAria,
  cancelAria,
  onWatch,
  onCancel,
}: ExecutionRowProps) {
  return (
    <li className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-muted/40">
      <span
        className={cn("h-2 w-2 shrink-0 rounded-full", STATUS_DOT[row.status])}
        aria-hidden="true"
      />
      <span className="shrink-0 rounded bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {kindLabel}
      </span>
      <span className="flex-1 truncate text-xs font-medium" title={row.label}>
        {row.label}
      </span>
      {elapsed && (
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground" title={elapsed}>
          {elapsed}
        </span>
      )}
      <span className="shrink-0 text-[11px] text-muted-foreground">{statusLabel}</span>
      {row.sessionId && (
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
          aria-label={watchAria}
          onClick={onWatch}
        >
          <Eye className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      )}
      {row.cancellable && (
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6 shrink-0 text-muted-foreground hover:text-red-500"
          aria-label={cancelAria}
          onClick={onCancel}
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      )}
    </li>
  )
}

interface MonitorControlsProps {
  prefs: ReturnType<typeof useExecutionMonitorPrefs>["prefs"]
  kindCounts: Record<ExecutionFilterKind, number>
  kindLabel: (kind: string) => string
  isDefault: boolean
  onToggleKind: (kind: ExecutionFilterKind, visible: boolean) => Promise<void>
  onSetSort: (sort: (typeof EXECUTION_MONITOR_SORTS)[number]) => Promise<void>
  onSetGroupByKind: (grouped: boolean) => Promise<void>
  onSetShowElapsed: (show: boolean) => Promise<void>
  onReset: () => Promise<void>
  t: ReturnType<typeof useTranslations>
}

function MonitorControls({
  prefs,
  kindCounts,
  kindLabel,
  isDefault,
  onToggleKind,
  onSetSort,
  onSetGroupByKind,
  onSetShowElapsed,
  onReset,
  t,
}: MonitorControlsProps) {
  const hiddenSet = new Set(prefs.hiddenKinds)
  return (
    <>
      <div>
        <p className="mb-2 text-xs font-medium">{t("controls.filterKinds")}</p>
        <div className="flex flex-wrap gap-1.5">
          {EXECUTION_FILTER_KINDS.map((kind) => {
            const visible = !hiddenSet.has(kind)
            const count = kindCounts[kind]
            return (
              <button
                key={kind}
                type="button"
                aria-pressed={visible}
                onClick={() => void onToggleKind(kind, !visible)}
                className={cn(
                  "flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors",
                  visible
                    ? "border-blue-500/40 bg-blue-500/10 text-foreground"
                    : "border-border/60 text-muted-foreground line-through opacity-70"
                )}
              >
                {kindLabel(kind)}
                {count > 0 && <span className="tabular-nums opacity-70">{count}</span>}
              </button>
            )
          })}
        </div>
      </div>

      <Separator />

      <div className="space-y-2">
        <p className="text-xs font-medium">{t("controls.sort")}</p>
        <ToggleGroup
          type="single"
          size="sm"
          variant="outline"
          value={prefs.sort}
          onValueChange={(value) => {
            if (value) void onSetSort(value as (typeof EXECUTION_MONITOR_SORTS)[number])
          }}
          className="w-full"
        >
          {EXECUTION_MONITOR_SORTS.map((sort) => (
            <ToggleGroupItem key={sort} value={sort} className="flex-1 text-[11px]">
              {t(`sort.${sort}`)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      <Separator />

      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="exec-group-by-kind" className="text-xs font-normal">
          {t("controls.groupByKind")}
        </Label>
        <Switch
          id="exec-group-by-kind"
          checked={prefs.groupByKind}
          onCheckedChange={(checked) => void onSetGroupByKind(checked)}
        />
      </div>
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="exec-show-elapsed" className="text-xs font-normal">
          {t("controls.showElapsed")}
        </Label>
        <Switch
          id="exec-show-elapsed"
          checked={prefs.showElapsed}
          onCheckedChange={(checked) => void onSetShowElapsed(checked)}
        />
      </div>

      <Separator />

      <Button
        size="sm"
        variant="ghost"
        className="h-7 w-full justify-center text-xs"
        disabled={isDefault}
        onClick={() => void onReset()}
      >
        <RotateCcw className="mr-1 h-3 w-3" aria-hidden="true" />
        {t("controls.reset")}
      </Button>
    </>
  )
}

/** Format the live elapsed time as the coarsest two-unit i18n string. */
function formatElapsed(
  t: ReturnType<typeof useTranslations>,
  startedAt: number,
  now: number
): string {
  const { hours, minutes, seconds } = elapsedPartsFrom(startedAt, now)
  if (hours > 0) return t("elapsed.hoursMinutes", { hours, minutes })
  if (minutes > 0) return t("elapsed.minutesSeconds", { minutes, seconds })
  return t("elapsed.seconds", { seconds })
}
