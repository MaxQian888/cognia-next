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
 * A range toggle (7d / 30d / all) filters every section; CSV/JSON export dumps
 * the raw billable rows.
 */

import { useEffect, useMemo, useState } from "react"
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
  ChevronDownIcon,
  CoinsIcon,
  DatabaseZapIcon,
  DownloadIcon,
  FoldVerticalIcon,
  HashIcon,
  RepeatIcon,
  UnfoldVerticalIcon,
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
import { SettingsAlert, SettingsEmptyState } from "@/components/settings/common/settings-section"
import { StatCard } from "@/components/scheduler/stat-card"
import { cn } from "@/lib/utils"

import { useThemeColors } from "@/hooks/logging/use-theme-colors"
import { paletteColor } from "@/lib/observability/chart-palette"
import { TOOLTIP_STYLE, CHART_MARGINS } from "@/lib/observability/chart-config"
import { isTauri } from "@/lib/tauri"
import { getDb } from "@/lib/db/schema"
import { listSessions } from "@/lib/db/sessions"
import { downloadBlob } from "@/lib/files/download"
import { formatCostInCurrency, formatTokens } from "@/types/system/usage"
import { useAnthropicUsage } from "@/lib/subscription/anthropic/hooks"
import { useAccounts } from "@/lib/subscription/core/hooks"
import { BalanceCard } from "@/components/settings/subscription/balance-card"
import { LimitsMetersCard } from "@/components/settings/subscription/limits-meters-card"
import { UsageDisplayToggle } from "@/components/settings/subscription/usage-display-toggle"
import { useUsageDisplayMode } from "@/hooks/usage/use-usage-display-mode"
import { useCountUp } from "@/hooks/usage/use-count-up"
import {
  MotionCollapse,
  MotionReveal,
  MotionStatusSwap,
  useFlowMotion,
} from "@/components/chat/motion/motion-reveal"
import type { UsageDisplayMode } from "@/types/appearance"
import type { ProviderId } from "@/types/subscription"
import {
  buildUtilizationSeries,
  splitCountdown,
  summarizeCurrentWindow,
  type CurrentWindowSummary,
  type UsageLevel,
  type WindowStatus,
} from "@/lib/subscription/anthropic/usage-analytics"
import {
  aggregateByDay,
  aggregateByModel,
  aggregateBySession,
  analyzeUsageContributors,
  buildUsageFilename,
  filterByRange,
  toUsageCsv,
  toUsageJson,
  type ModelUsageRow,
  type UsageContributors,
} from "@/lib/usage/session-analytics"
import type { SessionUsageRow, UsageSurface } from "@/lib/db/session-usage"
import type { SubscriptionUsageRow } from "@/types/subscription"
import type { ChatSession } from "@/lib/claude/types"
import { useChatStore } from "@/stores/chat"

const DAY_MS = 86_400_000

const RANGES = [
  { key: "7d", days: 7 },
  { key: "30d", days: 30 },
  { key: "all", days: null },
] as const

type RangeKey = (typeof RANGES)[number]["key"]

const SURFACE_FILTERS = ["all", "chat", "workflow", "agent-team"] as const
type SurfaceFilter = (typeof SURFACE_FILTERS)[number]

/** Keep rows whose producing surface matches the active filter. */
function filterBySurface(
  rows: readonly SessionUsageRow[],
  surface: SurfaceFilter
): SessionUsageRow[] {
  if (surface === "all") return [...rows]
  return rows.filter((r) => (r.surface ?? "chat") === (surface as UsageSurface))
}

const LEVEL_BAR: Record<UsageLevel, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  crit: "bg-destructive",
}

const LEVEL_TEXT: Record<UsageLevel, string> = {
  ok: "text-emerald-500",
  warn: "text-amber-500",
  crit: "text-destructive",
}

/* ── Section folding ────────────────────────────────────────────────────── */

/** Ids of the collapsible sections, in render order. */
const SECTION_IDS = ["window", "trend", "models", "insights", "cost", "sessions", "raw"] as const
type SectionId = (typeof SECTION_IDS)[number]

/**
 * Mode-driven default open state, mirroring the agent-flow progressive density:
 * the current window is always open, charts/tables open from `standard` up, and
 * the raw snapshot table only opens in `detailed`.
 */
function defaultOpenForMode(id: SectionId, mode: UsageDisplayMode): boolean {
  if (id === "window") return true
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
  const rangeDays = useMemo(() => RANGES.find((r) => r.key === range)?.days ?? null, [range])
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

  // Tick once a minute so reset countdowns and range cutoffs stay fresh
  // without reading `Date.now()` impurely during render.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])

  const filteredSessionRows = useMemo(
    () => filterBySurface(filterByRange(sessionRows, rangeDays, now), surface),
    [sessionRows, rangeDays, now, surface]
  )
  const models = useMemo(() => aggregateByModel(filteredSessionRows), [filteredSessionRows])
  const contributors = useMemo(
    () => analyzeUsageContributors(filteredSessionRows),
    [filteredSessionRows]
  )
  // Which surfaces actually appear in-range — drives the filter's visibility so
  // the toggle only shows up once non-chat usage exists.
  const availableSurfaces = useMemo(() => {
    const rangeRows = filterByRange(sessionRows, rangeDays, now)
    const set = new Set<UsageSurface>()
    for (const r of rangeRows) set.add(r.surface ?? "chat")
    return set
  }, [sessionRows, rangeDays, now])

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
      <UsageToolbar
        range={range}
        onRange={setRange}
        surface={surface}
        onSurface={setSurface}
        availableSurfaces={availableSurfaces}
        exportRows={filteredSessionRows}
        onExpandAll={() => setAllSections(true)}
        onCollapseAll={() => setAllSections(false)}
      />
      <BalancesSection now={now} />
      {models.length > 0 && (
        <MotionReveal index={0}>
          <UsageStatGrid models={models} />
        </MotionReveal>
      )}
      <MotionReveal index={1}>
        <CurrentWindowCard
          latest={latest}
          now={now}
          open={isOpen("window")}
          onToggle={() => toggleSection("window")}
        />
      </MotionReveal>
      <MotionReveal index={2}>
        <UtilizationTrendCard
          rows={snapshotRows}
          rangeDays={rangeDays}
          now={now}
          open={isOpen("trend")}
          onToggle={() => toggleSection("trend")}
        />
      </MotionReveal>
      <MotionReveal index={3}>
        <ModelBreakdownCard
          models={models}
          mode={mode}
          open={isOpen("models")}
          onToggle={() => toggleSection("models")}
        />
      </MotionReveal>
      <MotionReveal index={4}>
        <InsightsCard
          contributors={contributors}
          open={isOpen("insights")}
          onToggle={() => toggleSection("insights")}
        />
      </MotionReveal>
      <MotionReveal index={5}>
        <CostOverTimeCard
          rows={filteredSessionRows}
          open={isOpen("cost")}
          onToggle={() => toggleSection("cost")}
        />
      </MotionReveal>
      <MotionReveal index={6}>
        <TopSessionsCard
          rows={filteredSessionRows}
          mode={mode}
          open={isOpen("sessions")}
          onToggle={() => toggleSection("sessions")}
        />
      </MotionReveal>
      <MotionReveal index={7}>
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
}: {
  title: string
  description?: string
  open: boolean
  onToggle: () => void
  children: React.ReactNode
  testid?: string
}) {
  return (
    <Card data-testid={testid}>
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
          <div className="min-w-0 flex-1">
            <CardTitle className="text-base">{title}</CardTitle>
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
  availableSurfaces: Set<UsageSurface>
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

  // Only worth showing the surface toggle once spend exists beyond plain chat.
  const showSurface = availableSurfaces.has("workflow") || availableSurfaces.has("agent-team")

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
            className="flex gap-1"
            role="group"
            aria-label={t("surface.label")}
            data-testid="usage-surface-filter"
          >
            {SURFACE_FILTERS.map((s) => (
              <Button
                key={s}
                variant={surface === s ? "default" : "ghost"}
                size="sm"
                onClick={() => onSurface(s)}
                data-testid={`usage-surface-${s}`}
                aria-pressed={surface === s}
              >
                {t(`surface.${s === "agent-team" ? "agentTeam" : s}`)}
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
        <ProviderBalances key={provider} provider={provider} now={now} />
      ))}
    </div>
  )
}

/**
 * Render the active account of one non-anthropic provider in two complementary
 * cards: the credit/quota balance (`BalanceCard`, also the source `/billing`
 * reads), and the unified rate-limit *windows* (`LimitsMetersCard` in
 * windows-only mode — the desktop sibling of the TUI `/limits` bars, shown only
 * when the provider actually reports utilization windows, e.g. a real ChatGPT
 * subscription). No active account → nothing renders.
 */
function ProviderBalances({ provider, now }: { provider: ProviderId; now: number }) {
  const { accounts, activeAccountId } = useAccounts(provider)
  if (!activeAccountId) return null
  const active = accounts.find((a) => a.id === activeAccountId)
  const label = active?.label ?? active?.email ?? activeAccountId
  return (
    <>
      <LimitsMetersCard
        provider={provider}
        accountId={activeAccountId}
        label={label}
        now={now}
        windowsOnly
      />
      <BalanceCard provider={provider} accountId={activeAccountId} label={label} />
    </>
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

function UsageStatGrid({ models }: { models: ModelUsageRow[] }) {
  const t = useTranslations("subscription.usage.models")
  const totals = useMemo(
    () =>
      models.reduce(
        (acc, m) => {
          acc.tokens += m.inputTokens + m.outputTokens + m.cacheReadTokens
          acc.cost += m.costUsd
          acc.turns += m.turns
          acc.input += m.inputTokens
          acc.cacheRead += m.cacheReadTokens
          return acc
        },
        { tokens: 0, cost: 0, turns: 0, input: 0, cacheRead: 0 }
      ),
    [models]
  )
  // Same ratio convention as lib/db/agent-traces.ts traceSummary:
  // cacheRead / (input + cacheRead), 0 when no input recorded.
  const cacheHitRate =
    totals.input + totals.cacheRead > 0 ? totals.cacheRead / (totals.input + totals.cacheRead) : 0

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="usage-stat-grid">
      <UsageStatCard
        label={t("totalTokens")}
        value={totals.tokens}
        format={formatTokens}
        icon={<HashIcon className="h-5 w-5 text-blue-500" aria-hidden />}
        valueClassName="text-blue-500"
        accentGradient="from-blue-500 to-sky-400"
        iconBgClassName="bg-blue-500/10"
        testid="usage-model-stat-tokens"
      />
      <UsageStatCard
        label={t("totalCost")}
        value={totals.cost}
        format={(n) => formatCostInCurrency(n, "USD")}
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
        value={cacheHitRate * 100}
        format={(n) => `${Math.round(n)}%`}
        icon={<DatabaseZapIcon className="h-5 w-5 text-amber-500" aria-hidden />}
        valueClassName="text-amber-500"
        accentGradient="from-amber-500 to-yellow-400"
        iconBgClassName="bg-amber-500/10"
        testid="usage-model-stat-cache-hit-rate"
      />
    </div>
  )
}

/* ── Current window gauges ─────────────────────────────────────────────── */

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
  const summary: CurrentWindowSummary | null = useMemo(
    () => summarizeCurrentWindow(latest, { now }),
    [latest, now]
  )

  return (
    <UsageSection
      title={t("title")}
      description={t("description")}
      open={open}
      onToggle={onToggle}
      testid="usage-window-section"
    >
      {!summary ? (
        <p className="text-xs text-muted-foreground" data-testid="usage-window-empty">
          {t("noSnapshot")}
        </p>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2" data-testid="usage-current-window">
            <WindowGauge
              label={t("fiveHour")}
              window={summary.fiveHour}
              representative={summary.representativeClaim === "five_hour"}
              testid="usage-window-5h"
            />
            <WindowGauge
              label={t("sevenDay")}
              window={summary.sevenDay}
              representative={summary.representativeClaim === "seven_day"}
              testid="usage-window-7d"
            />
          </div>
          {summary.fallbackPercentage != null && (
            <SettingsAlert>
              {t("fallback", { pct: Math.round(summary.fallbackPercentage) })}
            </SettingsAlert>
          )}
          {summary.overageDisabledReason && (
            <SettingsAlert variant="destructive">
              {t("overageDisabled", { reason: summary.overageDisabledReason })}
            </SettingsAlert>
          )}
        </>
      )}
    </UsageSection>
  )
}

function WindowGauge({
  label,
  window,
  representative,
  testid,
}: {
  label: string
  window: WindowStatus | null
  representative: boolean
  testid: string
}) {
  const t = useTranslations("subscription.usage.window")

  if (!window) {
    return (
      <div className="rounded-lg border p-4 text-xs text-muted-foreground" data-testid={testid}>
        <span className="font-medium text-foreground">{label}</span> — {t("noData")}
      </div>
    )
  }

  const pct = Math.max(0, Math.min(100, Math.round(window.utilization)))
  const countdown =
    window.msUntilReset == null
      ? t("resetUnknown")
      : (() => {
          const parts = splitCountdown(window.msUntilReset)
          if (parts.expired) return t("resetExpired")
          return parts.hours > 0
            ? t("resetsInHm", { hours: parts.hours, minutes: parts.minutes })
            : t("resetsInM", { minutes: parts.minutes })
        })()

  return (
    <div className="space-y-2 rounded-lg border p-4" data-testid={testid}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        {representative && (
          <Badge variant="outline" className="text-[10px]">
            {t("representative")}
          </Badge>
        )}
      </div>
      <div className="flex items-baseline gap-2">
        <MotionStatusSwap swapKey={window.level}>
          <span className={cn("text-2xl font-bold tabular-nums", LEVEL_TEXT[window.level])}>
            {Math.round(window.utilization)}%
          </span>
        </MotionStatusSwap>
        <span className="text-xs text-muted-foreground">{t(`level.${window.level}`)}</span>
      </div>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div
          className={cn("h-full rounded-full transition-all duration-500", LEVEL_BAR[window.level])}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-xs text-muted-foreground">{countdown}</p>
    </div>
  )
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
  rangeDays: number | null
  now: number
  open: boolean
  onToggle: () => void
}) {
  const t = useTranslations("subscription.usage.trend")
  const colors = useThemeColors()
  const { reduce } = useFlowMotion()
  const series = useMemo(
    () =>
      buildUtilizationSeries(rows, {
        now,
        rangeMs: rangeDays != null ? rangeDays * DAY_MS : null,
      }),
    [rows, rangeDays, now]
  )

  return (
    <UsageSection
      title={t("title")}
      description={t("description")}
      open={open}
      onToggle={onToggle}
      testid="usage-trend-section"
    >
      {series.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="usage-trend-empty">
          {t("empty")}
        </p>
      ) : (
        <div className="h-56" data-testid="usage-trend-chart">
          <ResponsiveContainer width="100%" height="100%">
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
  const totalCost = useMemo(() => models.reduce((acc, m) => acc + m.costUsd, 0), [models])

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
    >
      <div className="grid gap-4 lg:grid-cols-2">
        {donut.length > 0 && (
          <div className="relative h-56" data-testid="usage-model-donut">
            <ResponsiveContainer width="100%" height="100%">
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
                {formatCostInCurrency(totalCost, "USD")}
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
                  <TableCell className="text-right font-mono text-xs">
                    {formatCostInCurrency(m.costUsd, "USD")}
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
  open,
  onToggle,
}: {
  rows: SessionUsageRow[]
  open: boolean
  onToggle: () => void
}) {
  const t = useTranslations("subscription.usage.costOverTime")
  const colors = useThemeColors()
  const { reduce } = useFlowMotion()
  const daily = useMemo(() => aggregateByDay(rows), [rows])

  return (
    <UsageSection
      title={t("title")}
      description={t("description")}
      open={open}
      onToggle={onToggle}
      testid="usage-cost-section"
    >
      {daily.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="usage-cost-empty">
          {t("empty")}
        </p>
      ) : (
        <div className="h-48" data-testid="usage-cost-chart">
          <ResponsiveContainer width="100%" height="100%">
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

  const summaries = useMemo(
    () =>
      aggregateBySession(rows)
        .filter((s) => s.costUsd > 0)
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
                    {formatCostInCurrency(s.costUsd, "USD")}
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
  rangeDays: number | null
  now: number
  open: boolean
  onToggle: () => void
}) {
  const t = useTranslations("subscription.usage")
  const filtered = useMemo(() => {
    if (rangeDays == null) return rows
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
