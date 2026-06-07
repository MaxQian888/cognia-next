"use client"

/**
 * Subscription → Claude → Usage tab.
 *
 * A full usage dashboard built from two persisted sources:
 *   • `subscriptionUsage` (rate-limit header snapshots) drives the current-
 *     window gauges + reset countdowns and the utilization trend chart.
 *   • `sessionUsage` (per-turn SDK usage) drives the per-model cost/token
 *     breakdown, the daily cost chart, and the top-sessions table — with
 *     real per-token cost back-filled when the SDK reported none.
 *
 * All aggregation is delegated to the pure helpers in
 * `lib/subscription/anthropic/usage-analytics.ts` and `lib/usage/session-
 * analytics.ts` so this file stays presentational and testable. A range
 * toggle (7d / 30d / all) filters every section; CSV/JSON export dumps the
 * raw billable rows.
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
import { CoinsIcon, DatabaseZapIcon, DownloadIcon, HashIcon, RepeatIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
import {
  SettingsAlert,
  SettingsCard,
  SettingsEmptyState,
} from "@/components/settings/common/settings-section"
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
  buildUsageFilename,
  filterByRange,
  toUsageCsv,
  toUsageJson,
} from "@/lib/usage/session-analytics"
import type { SessionUsageRow } from "@/lib/db/session-usage"
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

/* ── Root ──────────────────────────────────────────────────────────────── */

export function SubscriptionUsageTab() {
  const t = useTranslations("subscription")
  const tabReady = isTauri()
  const { rows: snapshotRows, latest, loading } = useAnthropicUsage(500)

  const liveSessionUsage = useLiveQuery(() => getDb().sessionUsage.toArray(), [])
  const sessionRows = useMemo(() => liveSessionUsage ?? [], [liveSessionUsage])

  const [range, setRange] = useState<RangeKey>("7d")
  const rangeDays = useMemo(() => RANGES.find((r) => r.key === range)?.days ?? null, [range])

  // Tick once a minute so reset countdowns and range cutoffs stay fresh
  // without reading `Date.now()` impurely during render.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])

  const filteredSessionRows = useMemo(
    () => filterByRange(sessionRows, rangeDays, now),
    [sessionRows, rangeDays, now]
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
    <div className="space-y-4" data-testid="usage-tab">
      <UsageToolbar range={range} onRange={setRange} exportRows={filteredSessionRows} />
      <BalancesSection />
      <CurrentWindowCard latest={latest} now={now} />
      <UtilizationTrendCard rows={snapshotRows} rangeDays={rangeDays} now={now} />
      <ModelBreakdownCard rows={filteredSessionRows} />
      <CostOverTimeCard rows={filteredSessionRows} />
      <TopSessionsCard rows={filteredSessionRows} />
      <RawSamplesCard rows={snapshotRows} rangeDays={rangeDays} now={now} />
    </div>
  )
}

/* ── Toolbar ───────────────────────────────────────────────────────────── */

function UsageToolbar({
  range,
  onRange,
  exportRows,
}: {
  range: RangeKey
  onRange: (key: RangeKey) => void
  exportRows: SessionUsageRow[]
}) {
  const t = useTranslations("subscription.usage")

  const onExport = (format: "csv" | "json") => {
    const content = format === "csv" ? toUsageCsv(exportRows) : toUsageJson(exportRows)
    const mime = format === "csv" ? "text/csv;charset=utf-8" : "application/json"
    downloadBlob(new Blob([content], { type: mime }), buildUsageFilename(format))
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
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
  )
}

/* ── Non-anthropic account balances ────────────────────────────────────── */

const BALANCE_PROVIDERS: readonly ProviderId[] = ["codex", "opencode"]

function BalancesSection() {
  return (
    <div className="space-y-3" data-testid="balances-section">
      {BALANCE_PROVIDERS.map((provider) => (
        <ProviderBalances key={provider} provider={provider} />
      ))}
    </div>
  )
}

/**
 * Render a balance card for the active account of one non-anthropic provider.
 * Only the active account is shown — the relay/preset it's bound to drives
 * which balance adapter (if any) matches. No active account → nothing renders.
 */
function ProviderBalances({ provider }: { provider: ProviderId }) {
  const { accounts, activeAccountId } = useAccounts(provider)
  if (!activeAccountId) return null
  const active = accounts.find((a) => a.id === activeAccountId)
  return (
    <BalanceCard
      provider={provider}
      accountId={activeAccountId}
      label={active?.label ?? active?.email ?? activeAccountId}
    />
  )
}

/* ── Current window gauges ─────────────────────────────────────────────── */

function CurrentWindowCard({ latest, now }: { latest: SubscriptionUsageRow | null; now: number }) {
  const t = useTranslations("subscription.usage.window")
  const summary: CurrentWindowSummary | null = useMemo(
    () => summarizeCurrentWindow(latest, { now }),
    [latest, now]
  )

  if (!summary) {
    return (
      <SettingsCard title={t("title")} description={t("description")}>
        <p className="text-xs text-muted-foreground" data-testid="usage-window-empty">
          {t("noSnapshot")}
        </p>
      </SettingsCard>
    )
  }

  return (
    <SettingsCard title={t("title")} description={t("description")}>
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
    </SettingsCard>
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
        <span className={cn("text-2xl font-bold tabular-nums", LEVEL_TEXT[window.level])}>
          {Math.round(window.utilization)}%
        </span>
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
          className={cn("h-full rounded-full transition-all", LEVEL_BAR[window.level])}
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
}: {
  rows: SubscriptionUsageRow[]
  rangeDays: number | null
  now: number
}) {
  const t = useTranslations("subscription.usage.trend")
  const colors = useThemeColors()
  const series = useMemo(
    () =>
      buildUtilizationSeries(rows, {
        now,
        rangeMs: rangeDays != null ? rangeDays * DAY_MS : null,
      }),
    [rows, rangeDays, now]
  )

  return (
    <SettingsCard title={t("title")} description={t("description")}>
      {series.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="usage-trend-empty">
          {t("empty")}
        </p>
      ) : (
        <div className="h-56" data-testid="usage-trend-chart">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={series} margin={CHART_MARGINS.compact}>
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
                fill={paletteColor(colors, 0)}
                fillOpacity={0.15}
                connectNulls
                isAnimationActive={false}
              />
              <Area
                type="monotone"
                dataKey="sevenDay"
                name={t("sevenDay")}
                stroke={paletteColor(colors, 2)}
                fill={paletteColor(colors, 2)}
                fillOpacity={0.15}
                connectNulls
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </SettingsCard>
  )
}

/* ── Per-model breakdown ───────────────────────────────────────────────── */

function ModelBreakdownCard({ rows }: { rows: SessionUsageRow[] }) {
  const t = useTranslations("subscription.usage.models")
  const colors = useThemeColors()
  const models = useMemo(() => aggregateByModel(rows), [rows])
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

  if (models.length === 0) {
    return (
      <SettingsCard title={t("title")} description={t("description")}>
        <p className="text-xs text-muted-foreground" data-testid="usage-models-empty">
          {t("empty")}
        </p>
      </SettingsCard>
    )
  }

  const donut = models
    .filter((m) => m.costUsd > 0)
    .slice(0, 8)
    .map((m, i) => ({ key: m.model, value: m.costUsd, color: paletteColor(colors, i) }))

  return (
    <SettingsCard title={t("title")} description={t("description")}>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          label={t("totalTokens")}
          value={formatTokens(totals.tokens)}
          icon={<HashIcon className="h-5 w-5 text-blue-500" aria-hidden />}
          valueClassName="text-blue-500"
          accentGradient="from-blue-500 to-sky-400"
          iconBgClassName="bg-blue-500/10"
          size="sm"
          testid="usage-model-stat-tokens"
        />
        <StatCard
          label={t("totalCost")}
          value={formatCostInCurrency(totals.cost, "USD")}
          icon={<CoinsIcon className="h-5 w-5 text-violet-500" aria-hidden />}
          valueClassName="text-violet-500"
          accentGradient="from-violet-500 to-purple-400"
          iconBgClassName="bg-violet-500/10"
          size="sm"
          testid="usage-model-stat-cost"
        />
        <StatCard
          label={t("totalTurns")}
          value={totals.turns}
          icon={<RepeatIcon className="h-5 w-5 text-emerald-500" aria-hidden />}
          valueClassName="text-emerald-500"
          accentGradient="from-emerald-500 to-green-400"
          iconBgClassName="bg-emerald-500/10"
          size="sm"
          testid="usage-model-stat-turns"
        />
        <StatCard
          label={t("cacheHitRate")}
          value={`${Math.round(cacheHitRate * 100)}%`}
          icon={<DatabaseZapIcon className="h-5 w-5 text-amber-500" aria-hidden />}
          valueClassName="text-amber-500"
          accentGradient="from-amber-500 to-yellow-400"
          iconBgClassName="bg-amber-500/10"
          size="sm"
          testid="usage-model-stat-cache-hit-rate"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {donut.length > 0 && (
          <div className="h-56" data-testid="usage-model-donut">
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
                  isAnimationActive={false}
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
                  <TableCell className="text-right font-mono text-xs">
                    {formatCostInCurrency(m.costUsd, "USD")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </SettingsCard>
  )
}

/* ── Cost over time ────────────────────────────────────────────────────── */

function CostOverTimeCard({ rows }: { rows: SessionUsageRow[] }) {
  const t = useTranslations("subscription.usage.costOverTime")
  const colors = useThemeColors()
  const daily = useMemo(() => aggregateByDay(rows), [rows])

  if (daily.length === 0) {
    return (
      <SettingsCard title={t("title")} description={t("description")}>
        <p className="text-xs text-muted-foreground" data-testid="usage-cost-empty">
          {t("empty")}
        </p>
      </SettingsCard>
    )
  }

  return (
    <SettingsCard title={t("title")} description={t("description")}>
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
            <Bar dataKey="cost" fill={paletteColor(colors, 3)} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </SettingsCard>
  )
}

/* ── Top sessions ──────────────────────────────────────────────────────── */

function TopSessionsCard({ rows }: { rows: SessionUsageRow[] }) {
  const t = useTranslations("subscription.usage.topSessions")
  const setActiveSession = useChatStore((s) => s.setActiveSession)
  const [titles, setTitles] = useState<Map<string, ChatSession>>(new Map())

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
    <SettingsCard title={t("title")} description={t("description")}>
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
    </SettingsCard>
  )
}

/* ── Raw snapshots (collapsible) ───────────────────────────────────────── */

function RawSamplesCard({
  rows,
  rangeDays,
  now,
}: {
  rows: SubscriptionUsageRow[]
  rangeDays: number | null
  now: number
}) {
  const t = useTranslations("subscription.usage")
  const filtered = useMemo(() => {
    if (rangeDays == null) return rows
    const cutoff = now - rangeDays * DAY_MS
    return rows.filter((r) => r.fetchedAt >= cutoff)
  }, [rows, rangeDays, now])

  return (
    <SettingsCard
      title={t("tableTitle")}
      description={t("tableDescription")}
      collapsible
      defaultOpen={false}
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
    </SettingsCard>
  )
}
