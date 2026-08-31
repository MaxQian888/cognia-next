"use client"

/**
 * Subscription → Claude → Usage tab.
 *
 * A full usage dashboard built from two persisted sources:
 *   • `subscriptionUsage` (rate-limit header snapshots) drives the current-
 *     window gauges + reset countdowns and the utilization trend chart.
 *   • `sessionUsage` (per-turn SDK usage) drives the headline stat tiles, the
 *     per-model cost/token breakdown, the daily cost chart, and the top-sessions
 *     table — with real per-token cost back-filled when the SDK reported none.
 *
 * All aggregation is delegated to the pure helpers in
 * `lib/subscription/anthropic/usage-analytics.ts` and `lib/usage/session-
 * analytics.ts` so this file stays presentational and testable.
 *
 * Display is mode-aware (simplified / standard / detailed) via the global
 * `useUsageDisplayMode`, mirroring the chat agent-flow pattern: simplified keeps
 * only the headline tiles + current window open, standard opens the charts and
 * tables, detailed additionally opens the raw snapshots and shows extra columns.
 * Each section folds independently (mode-default + session-local override, like
 * `tool-activity-group`), with an expand/collapse-all control. Motion is gated
 * through `useFlowMotion` so it honours reduced-motion.
 *
 * A range toggle (7d / 30d / 90d) filters every section; CSV/JSON export dumps
 * the raw billable rows. Cost over time draws the same daily aggregates either
 * as a calendar heatmap (default) or as the original bar chart.
 */

import { useEffect, useMemo, useState } from "react"
import { useSubscriptionNow } from "@/lib/subscription/core/now-ticker"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import {
  BarChart3Icon,
  CalendarRangeIcon,
  ChevronDownIcon,
  CoinsIcon,
  DatabaseZapIcon,
  DownloadIcon,
  FoldVerticalIcon,
  HashIcon,
  GaugeIcon,
  LayersIcon,
  LightbulbIcon,
  MessagesSquareIcon,
  TableIcon,
  TrendingUpIcon,
  RefreshCwIcon,
  RepeatIcon,
  Share2Icon,
  UnfoldVerticalIcon,
  WalletIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { SettingsAlert, SettingsEmptyState } from "@/components/settings/common/settings-section"
import { StatCard } from "@/components/scheduler/stat-card"
import { UsageHeatmap } from "@/components/usage/usage-heatmap"
import { UsageAttributionRow } from "@/components/usage/usage-attribution-row"
import { UsageBudgetMeters } from "@/components/usage/usage-budget-meters"
import { useCostBudgetStatus } from "@/hooks/usage/use-cost-budget-status"
import { cn } from "@/lib/utils"

import { useThemeColors } from "@/hooks/logging/use-theme-colors"
import { paletteColor } from "@/lib/observability/chart-palette"
import { TOOLTIP_STYLE, CHART_MARGINS } from "@/lib/observability/chart-config"
import { isTauri } from "@/lib/tauri"
import { getDb } from "@/lib/db/schema"
import { listSessions } from "@/lib/db/sessions"
import { downloadBlob } from "@/lib/files/download"
import {
  formatCostInCurrency,
  formatTokens,
  formatTokensPerSec,
  tokensPerSecond,
} from "@/types/system/usage"
import { useAnthropicUsage } from "@/lib/subscription/anthropic/hooks"
import { useAccounts } from "@/lib/subscription/core/hooks"
import { ProviderQuotaPanel } from "@/components/settings/subscription/provider-quota-panel"
import { WindowGaugeCard } from "@/components/settings/subscription/window-gauge-card"
import { UsageShareDialog } from "@/components/settings/subscription/usage-share-dialog"
import { UsageDisplayToggle } from "@/components/settings/subscription/usage-display-toggle"
import { useUsageDisplayMode } from "@/hooks/usage/use-usage-display-mode"
import { useCountUp } from "@/hooks/usage/use-count-up"
import { MotionCollapse, MotionReveal, useFlowMotion } from "@/components/chat/motion/motion-reveal"
import type { UsageDisplayMode } from "@/types/appearance"
import type { LimitsMeter, ProviderId } from "@/types/subscription"
import {
  buildUtilizationSeries,
  fallbackPercentWhole,
} from "@/lib/subscription/anthropic/usage-analytics"
import { resolveUsageWindows } from "@/lib/subscription/anthropic/overview-windows"
import { surfaceLabelKey } from "@/lib/usage/usage-surface-labels"
import { useProviderLimits } from "@/lib/subscription/limits/hooks"
import {
  aggregateByDay,
  aggregateByModel,
  aggregateBySession,
  aggregateBySurface,
  analyzeUsageContributors,
  buildUsageFilename,
  filterByRange,
  formatBucketCost,
  toUsageCsv,
  toUsageJson,
  type ModelUsageRow,
  type SurfaceUsageRow,
  type UsageContributors,
} from "@/lib/usage/session-analytics"
import {
  shareOfCost,
  shareOfTokens,
  summarizeSpend,
  type UsageSpendTotals,
} from "@/lib/usage/usage-report"
import { USAGE_SURFACES, type SessionUsageRow, type UsageSurface } from "@/lib/db/session-usage"
import type { SubscriptionUsageRow } from "@/types/subscription"
import type { ChatSession } from "@cognia/agent-config-types"
import { useChatStore } from "@/stores/chat"

const DAY_MS = 86_400_000

/**
 * Trailing local-calendar windows. "All time" is gone on purpose: `sessionUsage`
 * is pruned to 90 days, so the label promised history the table cannot hold.
 * 90 days is the honest ceiling and the widest grid the heatmap renders.
 */
const RANGES = [
  { key: "7d", days: 7 },
  { key: "30d", days: 30 },
  { key: "90d", days: 90 },
] as const

type RangeKey = (typeof RANGES)[number]["key"]

/**
 * The filter's value space is "all" plus every metered surface.
 *
 * It used to be a hard-coded `["all", "chat", "workflow", "agent-team"]`, which
 * quietly capped the tab at three of the fifteen surfaces `sessionUsage`
 * records. An embedding sweep, an OCR batch or a connector auto-reply all spend
 * real money, all get written, and none of them could be isolated here. The
 * rendered chips are still narrowed to the surfaces that actually appear in the
 * selected range, so the row only ever shows options with rows behind them.
 */
type SurfaceFilter = "all" | UsageSurface

/** How the cost-over-time section draws the same daily aggregates. */
const COST_VIEWS = ["heatmap", "bar"] as const
type CostView = (typeof COST_VIEWS)[number]

function isCostView(value: string): value is CostView {
  return (COST_VIEWS as readonly string[]).includes(value)
}

/** Keep rows whose producing surface matches the active filter. */
function filterBySurface(
  rows: readonly SessionUsageRow[],
  surface: SurfaceFilter
): SessionUsageRow[] {
  if (surface === "all") return [...rows]
  return rows.filter((r) => (r.surface ?? "chat") === (surface as UsageSurface))
}

/* ── Section folding ────────────────────────────────────────────────────── */

/** Ids of the collapsible sections, in render order. */
const SECTION_IDS = [
  "budget",
  "window",
  "trend",
  "models",
  "surfaces",
  "insights",
  "cost",
  "sessions",
  "raw",
] as const
type SectionId = (typeof SECTION_IDS)[number]

/**
 * Mode-driven default open state, mirroring the agent-flow progressive density:
 * the current window is always open, charts/tables open from `standard` up, and
 * the raw snapshot table only opens in `detailed`.
 */
function defaultOpenForMode(id: SectionId, mode: UsageDisplayMode): boolean {
  // The budget is open at every density: a ceiling you are close to is the one
  // thing on this tab that changes what happens on your next send.
  if (id === "window" || id === "budget") return true
  if (id === "raw") return mode === "detailed"
  return mode !== "simplified"
}

/* ── Root ──────────────────────────────────────────────────────────────── */

export function SubscriptionUsageTab() {
  const t = useTranslations("subscription")
  const tabReady = isTauri()
  const { mode } = useUsageDisplayMode()
  const { rows: snapshotRows, latest, loading } = useAnthropicUsage(500)

  const liveSessionUsage = useLiveQuery(() => getDb().sessionUsage.toArray(), [])
  const sessionRows = useMemo(() => liveSessionUsage ?? [], [liveSessionUsage])

  const [range, setRange] = useState<RangeKey>("7d")
  const rangeDays = useMemo(() => RANGES.find((r) => r.key === range)?.days ?? 7, [range])
  const [surface, setSurface] = useState<SurfaceFilter>("all")

  // Per-section fold overrides, scoped to the active mode: switching mode resets
  // folding to that mode's defaults (no effect syncing — a stale mode is treated
  // as an empty override set during render). Same convention as the agent-flow
  // tool-activity-group's sparse-map approach.
  const [fold, setFold] = useState<{ mode: UsageDisplayMode; map: Map<SectionId, boolean> }>(
    () => ({
      mode,
      map: new Map(),
    })
  )
  const overrides = fold.mode === mode ? fold.map : null
  const isOpen = (id: SectionId) =>
    overrides?.has(id) ? (overrides.get(id) as boolean) : defaultOpenForMode(id, mode)
  const toggleSection = (id: SectionId) =>
    setFold((prev) => {
      const base = prev.mode === mode ? prev.map : new Map<SectionId, boolean>()
      const next = new Map(base)
      const current = base.has(id) ? (base.get(id) as boolean) : defaultOpenForMode(id, mode)
      next.set(id, !current)
      return { mode, map: next }
    })
  const setAllSections = (open: boolean) =>
    setFold(() => ({ mode, map: new Map(SECTION_IDS.map((id) => [id, open])) }))

  // Shared clock: this page also renders the overview gauges and the quota
  // panel, which used to run their own intervals at a different period, so the
  // same window's countdown ticked at two different moments.
  const now = useSubscriptionNow()

  const rangeRows = useMemo(
    () => filterByRange(sessionRows, rangeDays, now),
    [sessionRows, rangeDays, now]
  )

  // Which surfaces actually appear in-range. Drives the filter row so it only
  // ever offers an option that has rows behind it, in the canonical
  // `USAGE_SURFACES` order rather than in first-seen order (which made the
  // chips reshuffle whenever a new surface spent something).
  const availableSurfaces = useMemo(() => {
    const seen = new Set<UsageSurface>()
    for (const row of rangeRows) seen.add(row.surface ?? "chat")
    return USAGE_SURFACES.filter((id) => seen.has(id))
  }, [rangeRows])

  // A filter pinned to a surface that fell out of the range would otherwise show
  // an empty tab with no way back except re-picking "all".
  const effectiveSurface: SurfaceFilter =
    surface !== "all" && !availableSurfaces.includes(surface) ? "all" : surface

  const filteredSessionRows = useMemo(
    () => filterBySurface(rangeRows, effectiveSurface),
    [rangeRows, effectiveSurface]
  )
  const models = useMemo(() => aggregateByModel(filteredSessionRows), [filteredSessionRows])
  const surfaces = useMemo(() => aggregateBySurface(filteredSessionRows), [filteredSessionRows])
  // One pass for the headline numbers. The stat grid used to re-reduce the model
  // rows, so this tab and the `/usage` card computed the same five figures with
  // two different accumulators and only one of them tracked unpriced turns.
  const totals = useMemo(() => summarizeSpend(filteredSessionRows), [filteredSessionRows])
  const contributors = useMemo(
    () => analyzeUsageContributors(filteredSessionRows),
    [filteredSessionRows]
  )

  if (!tabReady) {
    return (
      <SettingsAlert title={t("webModeBanner")}>
        <span data-testid="usage-web-banner">{t("webModeBanner")}</span>
      </SettingsAlert>
    )
  }

  if (loading) {
    return <p className="text-xs text-muted-foreground">{t("usage.loading")}</p>
  }

  if (snapshotRows.length === 0 && sessionRows.length === 0) {
    return (
      <div data-testid="usage-empty">
        <SettingsEmptyState title={t("usage.emptyTitle")} description={t("usage.emptyBody")} />
      </div>
    )
  }

  return (
    <div className="space-y-4" data-testid="usage-tab" data-mode={mode}>
      {/* Sticky: every section below is filtered by this row, and on a 90-day
          view the toolbar scrolled away long before the tables it controls. */}
      <div className="sticky top-0 z-10 -mx-1 bg-background/85 px-1 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/70">
        <UsageToolbar
          range={range}
          onRange={setRange}
          surface={effectiveSurface}
          onSurface={setSurface}
          availableSurfaces={availableSurfaces}
          exportRows={filteredSessionRows}
          onExpandAll={() => setAllSections(true)}
          onCollapseAll={() => setAllSections(false)}
        />
      </div>
      {/* Was the one section on this tab rendered outside `MotionReveal`, so it
          popped in while everything below it faded up in sequence. */}
      <MotionReveal index={0}>
        <BalancesSection now={now} />
      </MotionReveal>
      {totals.turns > 0 && (
        <MotionReveal index={1}>
          <UsageStatGrid totals={totals} />
        </MotionReveal>
      )}
      <MotionReveal index={2}>
        <BudgetCard open={isOpen("budget")} onToggle={() => toggleSection("budget")} />
      </MotionReveal>
      <MotionReveal index={3}>
        <CurrentWindowCard
          latest={latest}
          now={now}
          open={isOpen("window")}
          onToggle={() => toggleSection("window")}
        />
      </MotionReveal>
      <MotionReveal index={4}>
        <UtilizationTrendCard
          rows={snapshotRows}
          rangeDays={rangeDays}
          now={now}
          open={isOpen("trend")}
          onToggle={() => toggleSection("trend")}
        />
      </MotionReveal>
      <MotionReveal index={5}>
        <ModelBreakdownCard
          models={models}
          mode={mode}
          open={isOpen("models")}
          onToggle={() => toggleSection("models")}
        />
      </MotionReveal>
      {/* Two narrow, list-shaped sections. Side by side on a wide pane they read
          as one "where did it go" band instead of two more full-width slabs. */}
      <div className="grid gap-4 xl:grid-cols-2">
        <MotionReveal index={6}>
          <SurfaceBreakdownCard
            surfaces={surfaces}
            totals={totals}
            mode={mode}
            open={isOpen("surfaces")}
            onToggle={() => toggleSection("surfaces")}
          />
        </MotionReveal>
        <MotionReveal index={7}>
          <InsightsCard
            contributors={contributors}
            open={isOpen("insights")}
            onToggle={() => toggleSection("insights")}
          />
        </MotionReveal>
      </div>
      <MotionReveal index={8}>
        <CostOverTimeCard
          rows={filteredSessionRows}
          rangeDays={rangeDays}
          now={now}
          open={isOpen("cost")}
          onToggle={() => toggleSection("cost")}
        />
      </MotionReveal>
      <MotionReveal index={9}>
        <TopSessionsCard
          rows={filteredSessionRows}
          mode={mode}
          open={isOpen("sessions")}
          onToggle={() => toggleSection("sessions")}
        />
      </MotionReveal>
      <MotionReveal index={10}>
        <RawSamplesCard
          rows={snapshotRows}
          rangeDays={rangeDays}
          now={now}
          open={isOpen("raw")}
          onToggle={() => toggleSection("raw")}
        />
      </MotionReveal>
    </div>
  )
}

/* ── Collapsible section shell ──────────────────────────────────────────── */

/**
 * Controlled collapsible card matching `SettingsCard`'s look, but driven by an
 * external open state so the toolbar's expand/collapse-all can steer every
 * section at once. The body reveals through `MotionCollapse` (gated on
 * reduced-motion) for a consistent fold animation.
 */
function UsageSection({
  title,
  description,
  open,
  onToggle,
  children,
  testid,
  icon,
  badge,
}: {
  title: string
  description?: string
  open: boolean
  onToggle: () => void
  children: React.ReactNode
  testid?: string
  /** Leading glyph, so a collapsed stack of cards is scannable by shape. */
  icon?: React.ReactNode
  /** Status pill kept visible while the section is folded shut. */
  badge?: React.ReactNode
}) {
  return (
    <Card data-testid={testid} className="h-full">
      <CardHeader
        className="cursor-pointer pb-3 transition-colors hover:bg-muted/50"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            onToggle()
          }
        }}
        data-testid={testid ? `${testid}-header` : undefined}
      >
        <div className="flex items-center justify-between gap-2">
          {icon ? <span className="mt-0.5 self-start">{icon}</span> : null}
          <div className="min-w-0 flex-1">
            <CardTitle className="flex items-center gap-2 text-base">
              <span className="min-w-0 truncate">{title}</span>
              {badge}
            </CardTitle>
            {description && (
              <CardDescription className="mt-0.5 text-xs">{description}</CardDescription>
            )}
          </div>
          <ChevronDownIcon
            className={cn(
              "h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200",
              open && "rotate-180"
            )}
          />
        </div>
      </CardHeader>
      <MotionCollapse open={open}>
        <CardContent className="space-y-4">{children}</CardContent>
      </MotionCollapse>
    </Card>
  )
}

/* ── Toolbar ───────────────────────────────────────────────────────────── */

function UsageToolbar({
  range,
  onRange,
  surface,
  onSurface,
  availableSurfaces,
  exportRows,
  onExpandAll,
  onCollapseAll,
}: {
  range: RangeKey
  onRange: (key: RangeKey) => void
  surface: SurfaceFilter
  onSurface: (key: SurfaceFilter) => void
  availableSurfaces: readonly UsageSurface[]
  exportRows: SessionUsageRow[]
  onExpandAll: () => void
  onCollapseAll: () => void
}) {
  const t = useTranslations("subscription.usage")

  const onExport = (format: "csv" | "json") => {
    const content = format === "csv" ? toUsageCsv(exportRows) : toUsageJson(exportRows)
    const mime = format === "csv" ? "text/csv;charset=utf-8" : "application/json"
    downloadBlob(new Blob([content], { type: mime }), buildUsageFilename(format))
  }

  // Only worth showing the toggle once more than one surface has spent
  // anything: a single chip that filters to everything is a control with
  // nothing behind it.
  const showSurface = availableSurfaces.length > 1

  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1" role="group" aria-label={t("range.label")}>
          {RANGES.map((r) => (
            <Button
              key={r.key}
              variant={range === r.key ? "default" : "ghost"}
              size="sm"
              onClick={() => onRange(r.key)}
              data-testid={`usage-range-${r.key}`}
              aria-pressed={range === r.key}
            >
              {t(`range.${r.key}`)}
            </Button>
          ))}
        </div>
        {showSurface && (
          <div
            className="flex flex-wrap gap-1"
            role="group"
            aria-label={t("surface.label")}
            data-testid="usage-surface-filter"
          >
            {(["all", ...availableSurfaces] as const).map((id) => (
              <Button
                key={id}
                variant={surface === id ? "default" : "ghost"}
                size="sm"
                onClick={() => onSurface(id)}
                data-testid={`usage-surface-${id}`}
                aria-pressed={surface === id}
              >
                {t(`surface.${id === "all" ? "all" : surfaceLabelKey(id)}`)}
              </Button>
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2">
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={onExpandAll}
            data-testid="usage-expand-all"
            title={t("expandAll")}
            aria-label={t("expandAll")}
          >
            <UnfoldVerticalIcon className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onCollapseAll}
            data-testid="usage-collapse-all"
            title={t("collapseAll")}
            aria-label={t("collapseAll")}
          >
            <FoldVerticalIcon className="size-3.5" />
          </Button>
        </div>
        <UsageDisplayToggle />
        <UsageShareDialog
          rows={exportRows}
          rangeLabel={t(`range.${range}`)}
          trigger={
            <Button
              variant="outline"
              size="sm"
              disabled={exportRows.length === 0}
              data-testid="usage-share-card-trigger"
            >
              <Share2Icon className="size-3.5" />
              {t("shareCard.action")}
            </Button>
          }
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              disabled={exportRows.length === 0}
              data-testid="usage-export-trigger"
            >
              <DownloadIcon className="size-3.5" />
              {t("export.label")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => onExport("csv")} data-testid="usage-export-csv">
              {t("export.csv")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onExport("json")} data-testid="usage-export-json">
              {t("export.json")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}

/* ── Non-anthropic account limits (windows + credit balances) ──────────── */

const BALANCE_PROVIDERS: readonly ProviderId[] = ["codex", "opencode"]

function BalancesSection({ now }: { now: number }) {
  return (
    <div className="space-y-3" data-testid="balances-section">
      {BALANCE_PROVIDERS.map((provider) => (
        <ProviderQuotaPanel key={provider} provider={provider} now={now} />
      ))}
    </div>
  )
}

/* ── Headline stat tiles ───────────────────────────────────────────────── */

/** A single stat tile whose value counts up to its target (gated on motion). */
function UsageStatCard({
  label,
  value,
  format,
  icon,
  valueClassName,
  accentGradient,
  iconBgClassName,
  testid,
}: {
  label: string
  value: number
  format: (n: number) => string
  icon: React.ReactNode
  valueClassName: string
  accentGradient: string
  iconBgClassName: string
  testid: string
}) {
  const { reduce } = useFlowMotion()
  const shown = useCountUp(value, { disabled: reduce })
  return (
    <StatCard
      label={label}
      value={format(shown)}
      icon={icon}
      valueClassName={valueClassName}
      accentGradient={accentGradient}
      iconBgClassName={iconBgClassName}
      size="sm"
      testid={testid}
    />
  )
}

/**
 * The five headline figures, read straight off {@link summarizeSpend}.
 *
 * They used to be re-derived here by reducing the model rows, which duplicated
 * the accumulator in `usage-report.ts` and quietly disagreed with it: the local
 * version summed only input + output + cache-read (dropping cache writes) and
 * had no notion of a turn nobody could price, so an unpriced run showed a
 * settled dollar figure that was really a floor.
 */
function UsageStatGrid({ totals }: { totals: UsageSpendTotals }) {
  const t = useTranslations("subscription.usage.models")
  const tokens =
    totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheCreationTokens
  // Aggregate output-token throughput. Null when no turn reported a duration.
  const speed = tokensPerSecond(totals.outputTokens, totals.durationMs)
  const cacheHit = totals.cacheHitRate

  return (
    <div className="space-y-2">
      <div
        className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
        data-testid="usage-stat-grid"
      >
        <UsageStatCard
          label={t("totalTokens")}
          value={tokens}
          format={formatTokens}
          icon={<HashIcon className="h-5 w-5 text-blue-500" aria-hidden />}
          valueClassName="text-blue-500"
          accentGradient="from-blue-500 to-sky-400"
          iconBgClassName="bg-blue-500/10"
          testid="usage-model-stat-tokens"
        />
        <UsageStatCard
          label={t("totalCost")}
          value={totals.costUsd}
          // Through the shared bucket formatter, so a range containing turns no
          // pricing layer knew renders as a lower bound rather than as a total.
          format={(n) => formatBucketCost(n, totals.unpricedTurns, totals.turns)}
          icon={<CoinsIcon className="h-5 w-5 text-violet-500" aria-hidden />}
          valueClassName="text-violet-500"
          accentGradient="from-violet-500 to-purple-400"
          iconBgClassName="bg-violet-500/10"
          testid="usage-model-stat-cost"
        />
        <UsageStatCard
          label={t("totalTurns")}
          value={totals.turns}
          format={(n) => String(Math.round(n))}
          icon={<RepeatIcon className="h-5 w-5 text-emerald-500" aria-hidden />}
          valueClassName="text-emerald-500"
          accentGradient="from-emerald-500 to-green-400"
          iconBgClassName="bg-emerald-500/10"
          testid="usage-model-stat-turns"
        />
        <UsageStatCard
          label={t("cacheHitRate")}
          value={(cacheHit ?? 0) * 100}
          format={(n) => (cacheHit == null ? "—" : `${Math.round(n)}%`)}
          icon={<DatabaseZapIcon className="h-5 w-5 text-amber-500" aria-hidden />}
          valueClassName="text-amber-500"
          accentGradient="from-amber-500 to-yellow-400"
          iconBgClassName="bg-amber-500/10"
          testid="usage-model-stat-cache-hit-rate"
        />
        <UsageStatCard
          label={t("speed")}
          value={speed ?? 0}
          format={(n) => (speed == null ? "—" : t("speedUnit", { value: formatTokensPerSec(n) }))}
          icon={<GaugeIcon className="h-5 w-5 text-cyan-500" aria-hidden />}
          valueClassName="text-cyan-500"
          accentGradient="from-cyan-500 to-sky-400"
          iconBgClassName="bg-cyan-500/10"
          testid="usage-model-stat-speed"
        />
      </div>
      {totals.unpricedTurns > 0 && (
        <p className="text-[11px] text-muted-foreground" data-testid="usage-unpriced-note">
          {t("unpricedNote", { turns: totals.unpricedTurns })}
        </p>
      )}
    </div>
  )
}

/* ── Spending limits ───────────────────────────────────────────────────── */

/**
 * Live spend against the configured USD ceilings.
 *
 * The ceilings are edited in Settings and enforced in the send gate, and until
 * now nothing showed them next to the spend they cap. This is the tab that
 * already explains where the money went, so it is where "and how much of the
 * limit is left" belongs. The rows come from the shared `UsageBudgetMeters`,
 * so the editor and this card can never show two different numbers.
 */
function BudgetCard({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const t = useTranslations("subscription.usage.budget")
  const { configured, worst } = useCostBudgetStatus()

  return (
    <UsageSection
      title={t("title")}
      description={t("description")}
      open={open}
      onToggle={onToggle}
      testid="usage-budget-section"
      icon={<WalletIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
      badge={
        configured && worst && worst.level !== "ok" ? (
          <Badge
            variant={worst.level === "warning" ? "secondary" : "destructive"}
            data-testid="usage-budget-worst"
          >
            {t(`level.${worst.level}`)}
          </Badge>
        ) : null
      }
    >
      <UsageBudgetMeters emptyHint={t("empty")} />
    </UsageSection>
  )
}

/* ── Current window gauges ─────────────────────────────────────────────── */

/** Map a meter id onto the section's stable gauge testid slots. */
const WINDOW_TESTID: Record<string, string> = {
  session: "usage-window-5h",
  weekly: "usage-window-7d",
  weekly_opus: "usage-window-7d-opus",
  weekly_sonnet: "usage-window-7d-sonnet",
}

function CurrentWindowCard({
  latest,
  now,
  open,
  onToggle,
}: {
  latest: SubscriptionUsageRow | null
  now: number
  open: boolean
  onToggle: () => void
}) {
  const t = useTranslations("subscription.usage.window")
  // Fuse the free OAuth-endpoint snapshot with the header sample — newest
  // wins (see resolveUsageWindows). This keeps the gauges live even when the
  // user hasn't sent a chat message, and adds the opus/sonnet weekly windows
  // the header path can't see.
  const { activeAccountId } = useAccounts("anthropic")
  const { snapshot, refreshing, refresh } = useProviderLimits("anthropic", activeAccountId ?? "")
  const resolved = useMemo(() => resolveUsageWindows(snapshot, latest), [snapshot, latest])

  const bySlot = new Map(resolved.windows.map((m) => [m.id, m]))
  const extraWindows = resolved.windows.filter((m) => !(m.id === "session" || m.id === "weekly"))

  const refreshButton = (
    <Button
      variant="outline"
      size="sm"
      onClick={() => void refresh({ force: true })}
      disabled={refreshing || !activeAccountId}
      data-testid="usage-window-refresh"
      aria-label={t("refresh")}
    >
      <RefreshCwIcon className={cn("size-3.5", refreshing && "animate-spin")} aria-hidden />
      {t("refresh")}
    </Button>
  )

  return (
    <UsageSection
      title={t("title")}
      description={t("description")}
      open={open}
      onToggle={onToggle}
      testid="usage-window-section"
      icon={<GaugeIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
    >
      {resolved.windows.length === 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground" data-testid="usage-window-empty">
            {t("noSnapshot")}
          </p>
          {refreshButton}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground" data-testid="usage-window-source">
              {resolved.source === "endpoint" ? t("sourceEndpoint") : t("sourceHeaders")}
            </p>
            {refreshButton}
          </div>
          <div className="grid gap-4 sm:grid-cols-2" data-testid="usage-current-window">
            <WindowSlot
              meter={bySlot.get("session") ?? null}
              label={t("fiveHour")}
              now={now}
              representative={resolved.representativeClaim === "five_hour"}
              testid="usage-window-5h"
            />
            <WindowSlot
              meter={bySlot.get("weekly") ?? null}
              label={t("sevenDay")}
              now={now}
              representative={resolved.representativeClaim === "seven_day"}
              testid="usage-window-7d"
            />
            {extraWindows.map((meter) => (
              <WindowGaugeCard
                key={meter.id}
                meter={meter}
                now={now}
                testid={WINDOW_TESTID[meter.id] ?? `usage-window-${meter.id}`}
              />
            ))}
          </div>
          {resolved.fallbackPercentage != null && (
            <SettingsAlert>
              {t("fallback", { pct: fallbackPercentWhole(resolved.fallbackPercentage) ?? 0 })}
            </SettingsAlert>
          )}
          {resolved.overageDisabledReason && (
            <SettingsAlert variant="destructive">
              {t("overageDisabled", { reason: resolved.overageDisabledReason })}
            </SettingsAlert>
          )}
        </>
      )}
    </UsageSection>
  )
}

/** A gauge slot that renders a placeholder when its window wasn't reported. */
function WindowSlot({
  meter,
  label,
  now,
  representative,
  testid,
}: {
  meter: LimitsMeter | null
  label: string
  now: number
  representative: boolean
  testid: string
}) {
  const t = useTranslations("subscription.usage.window")
  if (!meter) {
    return (
      <div className="rounded-lg border p-4 text-xs text-muted-foreground" data-testid={testid}>
        <span className="font-medium text-foreground">{label}</span> — {t("noData")}
      </div>
    )
  }
  return <WindowGaugeCard meter={meter} now={now} representative={representative} testid={testid} />
}

/* ── Utilization trend ─────────────────────────────────────────────────── */

function UtilizationTrendCard({
  rows,
  rangeDays,
  now,
  open,
  onToggle,
}: {
  rows: SubscriptionUsageRow[]
  rangeDays: number
  now: number
  open: boolean
  onToggle: () => void
}) {
  const t = useTranslations("subscription.usage.trend")
  const colors = useThemeColors()
  const { reduce } = useFlowMotion()
  const series = useMemo(
    () => buildUtilizationSeries(rows, { now, rangeMs: rangeDays * DAY_MS }),
    [rows, rangeDays, now]
  )

  return (
    <UsageSection
      title={t("title")}
      description={t("description")}
      open={open}
      onToggle={onToggle}
      testid="usage-trend-section"
      icon={<TrendingUpIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
    >
      {series.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="usage-trend-empty">
          {t("empty")}
        </p>
      ) : (
        <div className="h-56" data-testid="usage-trend-chart">
          <ResponsiveContainer
            width="100%"
            height="100%"
            minWidth={1}
            minHeight={1}
            initialDimension={{ width: 320, height: 224 }}
          >
            <AreaChart data={series} margin={CHART_MARGINS.compact}>
              <defs>
                <linearGradient id="usage-trend-5h" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={paletteColor(colors, 0)} stopOpacity={0.4} />
                  <stop offset="100%" stopColor={paletteColor(colors, 0)} stopOpacity={0.04} />
                </linearGradient>
                <linearGradient id="usage-trend-7d" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={paletteColor(colors, 2)} stopOpacity={0.4} />
                  <stop offset="100%" stopColor={paletteColor(colors, 2)} stopOpacity={0.04} />
                </linearGradient>
              </defs>
              <XAxis dataKey="at" hide />
              <YAxis
                domain={[0, 100]}
                width={36}
                tick={{ fontSize: 11 }}
                tickFormatter={(v) => `${v}%`}
              />
              <Tooltip
                contentStyle={TOOLTIP_STYLE.contentStyle}
                labelStyle={TOOLTIP_STYLE.labelStyle}
                itemStyle={TOOLTIP_STYLE.itemStyle}
                labelFormatter={(v) => new Date(Number(v)).toLocaleString()}
                formatter={(value) => `${Math.round(Number(value))}%`}
              />
              <Area
                type="monotone"
                dataKey="fiveHour"
                name={t("fiveHour")}
                stroke={paletteColor(colors, 0)}
                fill="url(#usage-trend-5h)"
                connectNulls
                isAnimationActive={!reduce}
              />
              <Area
                type="monotone"
                dataKey="sevenDay"
                name={t("sevenDay")}
                stroke={paletteColor(colors, 2)}
                fill="url(#usage-trend-7d)"
                connectNulls
                isAnimationActive={!reduce}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </UsageSection>
  )
}

/* ── Per-model breakdown ───────────────────────────────────────────────── */

function ModelBreakdownCard({
  models,
  mode,
  open,
  onToggle,
}: {
  models: ModelUsageRow[]
  mode: UsageDisplayMode
  open: boolean
  onToggle: () => void
}) {
  const t = useTranslations("subscription.usage.models")
  const colors = useThemeColors()
  const { reduce } = useFlowMotion()
  const showCacheWrite = mode === "detailed"
  const totals = useMemo(
    () =>
      models.reduce(
        (acc, m) => {
          acc.costUsd += m.costUsd
          acc.turns += m.turns
          acc.unpricedTurns += m.unpricedTurns
          return acc
        },
        { costUsd: 0, turns: 0, unpricedTurns: 0 }
      ),
    [models]
  )

  if (models.length === 0) {
    return (
      <UsageSection
        title={t("title")}
        description={t("description")}
        open={open}
        onToggle={onToggle}
        testid="usage-models-section"
      >
        <p className="text-xs text-muted-foreground" data-testid="usage-models-empty">
          {t("empty")}
        </p>
      </UsageSection>
    )
  }

  const donut = models
    .filter((m) => m.costUsd > 0)
    .slice(0, 8)
    .map((m, i) => ({ key: m.model, value: m.costUsd, color: paletteColor(colors, i) }))

  return (
    <UsageSection
      title={t("title")}
      description={t("description")}
      open={open}
      onToggle={onToggle}
      testid="usage-models-section"
      icon={<HashIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
    >
      <div className="grid gap-4 lg:grid-cols-2">
        {donut.length > 0 && (
          <div className="relative h-56" data-testid="usage-model-donut">
            <ResponsiveContainer
              width="100%"
              height="100%"
              minWidth={1}
              minHeight={1}
              initialDimension={{ width: 320, height: 224 }}
            >
              <PieChart>
                <Pie
                  data={donut}
                  dataKey="value"
                  nameKey="key"
                  cx="50%"
                  cy="50%"
                  innerRadius="55%"
                  outerRadius="80%"
                  paddingAngle={2}
                  isAnimationActive={!reduce}
                >
                  {donut.map((d) => (
                    <Cell key={d.key} fill={d.color} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={TOOLTIP_STYLE.contentStyle}
                  labelStyle={TOOLTIP_STYLE.labelStyle}
                  itemStyle={TOOLTIP_STYLE.itemStyle}
                  formatter={(value) => formatCostInCurrency(Number(value), "USD")}
                />
              </PieChart>
            </ResponsiveContainer>
            {/* Donut center read-out — total spend across all priced models. */}
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {t("donutCenter")}
              </span>
              <span className="text-lg font-bold tabular-nums">
                {formatBucketCost(totals.costUsd, totals.unpricedTurns, totals.turns)}
              </span>
            </div>
          </div>
        )}

        <div className={cn("overflow-x-auto", donut.length === 0 && "lg:col-span-2")}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("colModel")}</TableHead>
                <TableHead className="text-right">{t("colTurns")}</TableHead>
                <TableHead className="text-right">{t("colInput")}</TableHead>
                <TableHead className="text-right">{t("colOutput")}</TableHead>
                <TableHead className="hidden text-right sm:table-cell">{t("colCache")}</TableHead>
                {showCacheWrite && (
                  <TableHead className="hidden text-right sm:table-cell">
                    {t("colCacheWrite")}
                  </TableHead>
                )}
                {showCacheWrite && (
                  <TableHead className="hidden text-right sm:table-cell">
                    {t("colReasoning")}
                  </TableHead>
                )}
                <TableHead className="hidden text-right sm:table-cell">{t("colSpeed")}</TableHead>
                <TableHead className="text-right">{t("colCost")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {models.map((m) => (
                <TableRow key={m.model} data-testid={`usage-model-row-${m.model}`}>
                  <TableCell className="max-w-[12rem] truncate font-mono text-xs">
                    {m.model}
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums">{m.turns}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums">
                    {formatTokens(m.inputTokens)}
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums">
                    {formatTokens(m.outputTokens)}
                  </TableCell>
                  <TableCell className="hidden text-right text-xs tabular-nums sm:table-cell">
                    {formatTokens(m.cacheReadTokens)}
                  </TableCell>
                  {showCacheWrite && (
                    <TableCell className="hidden text-right text-xs tabular-nums sm:table-cell">
                      {formatTokens(m.cacheCreationTokens)}
                    </TableCell>
                  )}
                  {showCacheWrite && (
                    <TableCell className="hidden text-right text-xs tabular-nums sm:table-cell">
                      {m.reasoningTokens > 0 ? formatTokens(m.reasoningTokens) : "—"}
                    </TableCell>
                  )}
                  <TableCell className="hidden text-right text-xs tabular-nums sm:table-cell">
                    {(() => {
                      const s = tokensPerSecond(m.outputTokens, m.durationMs)
                      return s == null ? "—" : t("speedUnit", { value: formatTokensPerSec(s) })
                    })()}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {formatBucketCost(m.costUsd, m.unpricedTurns, m.turns)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </UsageSection>
  )
}

/* ── Per-surface attribution ───────────────────────────────────────────── */

/**
 * Where the quota actually went, by producing surface.
 *
 * `aggregateBySurface` calls this "the honest answer to what is using my
 * quota", and it was already computed for the `/usage` transcript card and for
 * the CLI. The dashboard, which is the surface people open to ask exactly that
 * question, only had a filter: it could hide the other surfaces but never rank
 * them. Chat, an agent team, a scheduled workflow and a connector auto-reply
 * all draw on the same plan, and this axis is the only one that separates them.
 *
 * Rows are the shared `UsageAttributionRow`, so they rank and render exactly as
 * they do in the transcript card.
 */
function SurfaceBreakdownCard({
  surfaces,
  totals,
  mode,
  open,
  onToggle,
}: {
  surfaces: SurfaceUsageRow[]
  totals: UsageSpendTotals
  mode: UsageDisplayMode
  open: boolean
  onToggle: () => void
}) {
  const t = useTranslations("subscription.usage.bySurface")
  const tSurface = useTranslations("subscription.usage.surface")
  const { reduce } = useFlowMotion()

  return (
    <UsageSection
      title={t("title")}
      description={t("description")}
      open={open}
      onToggle={onToggle}
      testid="usage-surfaces-section"
      icon={<LayersIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
    >
      {surfaces.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="usage-surfaces-empty">
          {t("empty")}
        </p>
      ) : (
        <ul className="space-y-2.5" data-testid="usage-surfaces-list">
          {surfaces.map((row) => {
            // Rank by cost where cost is known, else by tokens. A local or free
            // model can dominate the token budget at $0, and a 0% row would
            // bury exactly the surface worth looking at.
            const share = shareOfCost(row, totals) ?? shareOfTokens(row, totals)
            return (
              <UsageAttributionRow
                key={row.surface}
                id={row.surface}
                testidPrefix="usage-surface-row"
                label={tSurface(surfaceLabelKey(row.surface))}
                pct={share == null ? null : Math.round(share * 100)}
                costUsd={row.costUsd}
                unpricedTurns={row.unpricedTurns}
                turns={row.turns}
                reduce={reduce}
                detail={
                  mode === "simplified"
                    ? undefined
                    : t("rowDetail", {
                        turns: row.turns,
                        tokens: formatTokens(
                          row.inputTokens +
                            row.outputTokens +
                            row.cacheReadTokens +
                            row.cacheCreationTokens
                        ),
                      })
                }
              />
            )
          })}
        </ul>
      )}
    </UsageSection>
  )
}

/* ── Contributing-factor insights ──────────────────────────────────────── */

/**
 * "What's contributing to your usage?" — Claude-Code-style characteristics of
 * the in-range usage (long-context turns, automated-surface cost share). Each is
 * an independent characteristic, not a breakdown that sums to 100%, and is shown
 * only when it applies; when none do, an empty hint keeps the section honest.
 */
function InsightsCard({
  contributors,
  open,
  onToggle,
}: {
  contributors: UsageContributors
  open: boolean
  onToggle: () => void
}) {
  const t = useTranslations("subscription.usage.insights")
  const items = contributors.contributors
  return (
    <UsageSection
      title={t("title")}
      description={t("description")}
      open={open}
      onToggle={onToggle}
      testid="usage-insights-section"
      icon={<LightbulbIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
    >
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="usage-insights-empty">
          {t("empty")}
        </p>
      ) : (
        <ul className="space-y-3" data-testid="usage-insights-list">
          {items.map((item) => (
            <li key={item.id} className="flex gap-2.5" data-testid={`usage-insight-${item.id}`}>
              <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" />
              <div className="min-w-0 space-y-0.5">
                <p className="text-sm font-medium">
                  {t(
                    `${item.id === "high-context" ? "highContext" : "automatedSurface"}.headline`,
                    {
                      pct: item.pct,
                    }
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t(`${item.id === "high-context" ? "highContext" : "automatedSurface"}.advice`)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </UsageSection>
  )
}

/* ── Cost over time ────────────────────────────────────────────────────── */

function CostOverTimeCard({
  rows,
  rangeDays,
  now,
  open,
  onToggle,
}: {
  rows: SessionUsageRow[]
  rangeDays: number
  now: number
  open: boolean
  onToggle: () => void
}) {
  const t = useTranslations("subscription.usage.costOverTime")
  const colors = useThemeColors()
  const { reduce } = useFlowMotion()
  const daily = useMemo(() => aggregateByDay(rows), [rows])
  // View choice is page-local on purpose: it is a way of looking at the same
  // numbers, not a preference worth persisting into settings.
  const [view, setView] = useState<CostView>("heatmap")

  return (
    <UsageSection
      title={t("title")}
      description={t("description")}
      open={open}
      onToggle={onToggle}
      testid="usage-cost-section"
      icon={<CoinsIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
    >
      <ToggleGroup
        type="single"
        size="sm"
        value={view}
        onValueChange={(value) => {
          if (isCostView(value)) setView(value)
        }}
        aria-label={t("view.label")}
        data-testid="usage-cost-view-toggle"
      >
        <ToggleGroupItem
          value="heatmap"
          aria-label={t("view.heatmap")}
          data-testid="usage-cost-view-heatmap"
        >
          <CalendarRangeIcon className="size-3.5" />
        </ToggleGroupItem>
        <ToggleGroupItem value="bar" aria-label={t("view.bar")} data-testid="usage-cost-view-bar">
          <BarChart3Icon className="size-3.5" />
        </ToggleGroupItem>
      </ToggleGroup>
      {daily.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="usage-cost-empty">
          {t("empty")}
        </p>
      ) : view === "heatmap" ? (
        <UsageHeatmap daily={daily} rangeDays={rangeDays} now={now} />
      ) : (
        <div className="h-48" data-testid="usage-cost-chart">
          <ResponsiveContainer
            width="100%"
            height="100%"
            minWidth={1}
            minHeight={1}
            initialDimension={{ width: 320, height: 192 }}
          >
            <BarChart data={daily} margin={CHART_MARGINS.compact}>
              <XAxis dataKey="date" hide />
              <YAxis
                width={48}
                tick={{ fontSize: 11 }}
                tickFormatter={(v) => formatCostInCurrency(Number(v), "USD")}
              />
              <Tooltip
                contentStyle={TOOLTIP_STYLE.contentStyle}
                labelStyle={TOOLTIP_STYLE.labelStyle}
                itemStyle={TOOLTIP_STYLE.itemStyle}
                formatter={(value) => formatCostInCurrency(Number(value), "USD")}
              />
              <Bar
                dataKey="cost"
                fill={paletteColor(colors, 3)}
                radius={[4, 4, 0, 0]}
                isAnimationActive={!reduce}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </UsageSection>
  )
}

/* ── Top sessions ──────────────────────────────────────────────────────── */

function TopSessionsCard({
  rows,
  mode,
  open,
  onToggle,
}: {
  rows: SessionUsageRow[]
  mode: UsageDisplayMode
  open: boolean
  onToggle: () => void
}) {
  const t = useTranslations("subscription.usage.topSessions")
  const setActiveSession = useChatStore((s) => s.setActiveSession)
  const [titles, setTitles] = useState<Map<string, ChatSession>>(new Map())
  const showSplit = mode === "detailed"

  // Keep every session that recorded a turn, not only the ones with a positive
  // cost. The old `costUsd > 0` filter dropped exactly the sessions someone
  // hunting unexplained spend needs: a run on a model no pricing layer knew
  // contributes 0 and would vanish from a table titled "top sessions".
  const summaries = useMemo(
    () =>
      aggregateBySession(rows)
        .filter((s) => s.turns > 0)
        .slice(0, 10),
    [rows]
  )

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const sessions = await listSessions()
        if (!cancelled) setTitles(new Map(sessions.map((s) => [s.id, s])))
      } catch {
        if (!cancelled) setTitles(new Map())
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <UsageSection
      title={t("title")}
      description={t("description")}
      open={open}
      onToggle={onToggle}
      testid="usage-sessions-section"
      icon={<MessagesSquareIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
    >
      {summaries.length === 0 ? (
        <p
          className="rounded border bg-muted/30 p-4 text-center text-xs italic text-muted-foreground"
          data-testid="usage-top-empty"
        >
          {t("empty")}
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>#</TableHead>
              <TableHead>{t("colSession")}</TableHead>
              <TableHead className="text-right">{t("colTurns")}</TableHead>
              {showSplit && <TableHead className="text-right">{t("colInput")}</TableHead>}
              {showSplit && <TableHead className="text-right">{t("colOutput")}</TableHead>}
              <TableHead className="text-right">{t("colTokens")}</TableHead>
              <TableHead className="text-right">{t("colCost")}</TableHead>
              <TableHead className="text-right">{t("colActions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {summaries.map((s, idx) => {
              const session = titles.get(s.sessionId) ?? null
              return (
                <TableRow key={s.sessionId} data-testid={`top-session-${s.sessionId}`}>
                  <TableCell className="text-xs text-muted-foreground">{idx + 1}</TableCell>
                  <TableCell className="max-w-[16rem] truncate">
                    {session?.title ?? t("untitled")}
                    <p className="truncate font-mono text-[10px] text-muted-foreground">
                      {s.sessionId}
                    </p>
                  </TableCell>
                  <TableCell className="text-right text-xs">{s.turns}</TableCell>
                  {showSplit && (
                    <TableCell className="text-right text-xs tabular-nums">
                      {formatTokens(s.inputTokens)}
                    </TableCell>
                  )}
                  {showSplit && (
                    <TableCell className="text-right text-xs tabular-nums">
                      {formatTokens(s.outputTokens)}
                    </TableCell>
                  )}
                  <TableCell className="text-right text-xs">{formatTokens(s.tokens)}</TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {formatBucketCost(s.costUsd, s.unpricedTurns, s.turns)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setActiveSession(s.sessionId)}
                      disabled={!session}
                      data-testid={`top-session-resume-${s.sessionId}`}
                    >
                      {t("resume")}
                    </Button>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}
    </UsageSection>
  )
}

/* ── Raw snapshots (collapsible) ───────────────────────────────────────── */

function RawSamplesCard({
  rows,
  rangeDays,
  now,
  open,
  onToggle,
}: {
  rows: SubscriptionUsageRow[]
  rangeDays: number
  now: number
  open: boolean
  onToggle: () => void
}) {
  const t = useTranslations("subscription.usage")
  const filtered = useMemo(() => {
    const cutoff = now - rangeDays * DAY_MS
    return rows.filter((r) => r.fetchedAt >= cutoff)
  }, [rows, rangeDays, now])

  return (
    <UsageSection
      title={t("tableTitle")}
      description={t("tableDescription")}
      open={open}
      onToggle={onToggle}
      testid="usage-raw-section"
      icon={<TableIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
    >
      {filtered.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="usage-raw-empty">
          {t("emptyBody")}
        </p>
      ) : (
        <ScrollArea className="h-[360px]">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("col.fetchedAt")}</TableHead>
                <TableHead>{t("col.source")}</TableHead>
                <TableHead>{t("col.status")}</TableHead>
                <TableHead className="text-right">{t("col.fiveHour")}</TableHead>
                <TableHead className="text-right">{t("col.sevenDay")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((row) => (
                <TableRow key={row.localId ?? row.fetchedAt}>
                  <TableCell className="font-mono text-xs">
                    {new Date(row.fetchedAt).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    <Badge variant={row.source === "probe" ? "default" : "secondary"}>
                      {row.source}
                    </Badge>
                  </TableCell>
                  <TableCell>{row.status}</TableCell>
                  <TableCell className="text-right font-mono">
                    {row.fiveHour ? `${Math.round(row.fiveHour.utilization * 100)}%` : "—"}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {row.sevenDay ? `${Math.round(row.sevenDay.utilization * 100)}%` : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollArea>
      )}
    </UsageSection>
  )
}
