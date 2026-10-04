"use client"

/**
 * LogStatsDashboard
 *
 * Recharts-based visualization dashboard for log analytics.
 * Shows level distribution, log volume over time, module activity,
 * summary stat cards, error trend detection, and top errors.
 *
 * Every click-through has a keyboard path. The stat tiles that name a filter
 * (error rate, warning rate, most active module) are buttons; the level pie
 * has its legend rows; the module bar chart — a canvas of SVG rects no key
 * can reach — has a ranked list of the same modules that stays visually
 * hidden until keyboard focus enters it.
 */

import { useId, useMemo } from "react"
import { useFormatter, useTranslations, useLocale } from "next-intl"
import {
  PieChart,
  Pie,
  Cell,
  AreaChart,
  Area,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Activity,
  AlertTriangle,
  Clock,
  Layers,
  Gauge,
  Hash,
  Grid3X3,
  AlertCircle,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { StatCard } from "@/components/observability/stat-card"
import { TOOLTIP_STYLE, CHART_MARGINS } from "@/lib/observability/chart-config"
import { LEVEL_THEME } from "@cognia/logging/level-theme"
import { useThemeColors } from "@/hooks/logging/use-theme-colors"
import type { StructuredLogEntry, LogLevel } from "@cognia/logging"
import type { NativeLoggingReadiness } from "@/lib/native/native-logging-readiness"

const KNOWN_LEVELS = new Set<string>(["trace", "debug", "info", "warn", "error", "fatal"])
const KNOWN_HEALTH = new Set<string>(["healthy", "degraded", "offline", "inactive"])

export interface LogStatsDashboardProps {
  logs: StructuredLogEntry[]
  logRate?: number
  nativeLogging?: NativeLoggingReadiness
  /** "Top errors" click-through: search for the message. */
  onSearchFilter?: (query: string) => void
  /** Module-activity bar click-through. */
  onModuleFilter?: (moduleName: string) => void
  /** Level-distribution click-through (slice or legend row). */
  onLevelFilter?: (level: LogLevel) => void
  className?: string
}

function DashboardSection({
  title,
  children,
  className,
}: {
  title: string
  children: React.ReactNode
  className?: string
}) {
  const titleId = useId()

  return (
    <section aria-labelledby={titleId} className={cn("min-w-0 border-y bg-background", className)}>
      <header className="border-b px-4 py-3">
        <h3 id={titleId} className="text-sm font-medium">
          {title}
        </h3>
      </header>
      <div className="p-4">{children}</div>
    </section>
  )
}

/** Bucket widths the volume chart may use, in minutes — round numbers only. */
const BUCKET_STEPS_MINUTES = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 10080]
/** Upper bound on bars: past this a bucket is a pixel or two wide. */
const MAX_VOLUME_BUCKETS = 60

/**
 * The bucket width for a span of data: the smallest round step that keeps the
 * chart within `MAX_VOLUME_BUCKETS`. It used to be a fixed five minutes, capped
 * at 96 buckets — so anything older than eight hours was cut off the chart
 * (the window is up to seven days), and a two-minute burst was one fat bar.
 */
export function pickVolumeBucketMinutes(spanMs: number): number {
  const span = Math.max(0, spanMs)
  for (const step of BUCKET_STEPS_MINUTES) {
    if (Math.floor(span / (step * 60_000)) + 1 <= MAX_VOLUME_BUCKETS) return step
  }
  return BUCKET_STEPS_MINUTES[BUCKET_STEPS_MINUTES.length - 1]
}

/**
 * Compute time-bucketed log counts for the volume chart. The bucket width
 * follows the data's span (see `pickVolumeBucketMinutes`).
 */
export function computeVolumeBuckets(
  logs: StructuredLogEntry[],
  locale = "en"
): { time: string; info: number; warn: number; error: number; other: number }[] {
  if (logs.length === 0) return []

  let first = Infinity
  let last = -Infinity
  for (const log of logs) {
    const ts = new Date(log.timestamp).getTime()
    if (ts < first) first = ts
    if (ts > last) last = ts
  }
  const span = last - first
  const bucketMs = pickVolumeBucketMinutes(span) * 60 * 1000
  const bucketCount = Math.min(MAX_VOLUME_BUCKETS, Math.floor(span / bucketMs) + 1)
  // Buckets are aligned to the first entry, so the oldest entry is always on
  // the chart and the last bucket holds the newest.
  const startTime = first
  // A chart over more than a day labels its buckets with the date too —
  // "09:00" alone repeats once per day.
  const labelFormat: Intl.DateTimeFormatOptions =
    span >= 24 * 60 * 60 * 1000
      ? { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }
      : { hour: "2-digit", minute: "2-digit", hour12: false }

  const buckets: { time: string; info: number; warn: number; error: number; other: number }[] = []
  for (let i = 0; i < bucketCount; i++) {
    const bucketStart = startTime + i * bucketMs
    buckets.push({
      time: new Date(bucketStart).toLocaleString(locale, labelFormat),
      info: 0,
      warn: 0,
      error: 0,
      other: 0,
    })
  }

  for (const log of logs) {
    const ts = new Date(log.timestamp).getTime()
    const idx = Math.min(Math.floor((ts - startTime) / bucketMs), bucketCount - 1)
    if (idx < 0) continue

    if (log.level === "error" || log.level === "fatal") {
      buckets[idx].error++
    } else if (log.level === "warn") {
      buckets[idx].warn++
    } else if (log.level === "info") {
      buckets[idx].info++
    } else {
      buckets[idx].other++
    }
  }

  return buckets
}

function computeErrorTrendData(volumeData: ReturnType<typeof computeVolumeBuckets>) {
  if (volumeData.length === 0) {
    return []
  }

  const half = Math.max(1, Math.ceil(volumeData.length / 2))
  const current = volumeData.slice(-half)
  const previous = volumeData.slice(
    Math.max(0, volumeData.length - half * 2),
    Math.max(0, volumeData.length - half)
  )

  return current.map((bucket, index) => {
    const currentTotal = bucket.info + bucket.warn + bucket.error + bucket.other
    const previousBucket = previous[index]
    const previousTotal = previousBucket
      ? previousBucket.info + previousBucket.warn + previousBucket.error + previousBucket.other
      : 0
    return {
      time: bucket.time,
      current: currentTotal > 0 ? Number(((bucket.error / currentTotal) * 100).toFixed(1)) : 0,
      previous:
        previousBucket && previousTotal > 0
          ? Number(((previousBucket.error / previousTotal) * 100).toFixed(1))
          : 0,
    }
  })
}

export function LogStatsDashboard({
  logs,
  logRate = 0,
  nativeLogging,
  onSearchFilter,
  onModuleFilter,
  onLevelFilter,
  className,
}: LogStatsDashboardProps) {
  const t = useTranslations("logging")
  const locale = useLocale()
  const format = useFormatter()
  const themeColors = useThemeColors()
  const percent = (ratio: number) =>
    format.number(ratio, { style: "percent", maximumFractionDigits: 1 })

  // Level distribution data
  const levelData = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const log of logs) {
      counts[log.level] = (counts[log.level] || 0) + 1
    }
    return Object.entries(counts)
      .filter(([, count]) => count > 0)
      .map(([level, count]) => ({
        level: level as LogLevel,
        // The slice label and tooltip print `name`; it was the raw level key.
        name: t(`levels.${level as LogLevel}`),
        value: count,
        color: themeColors[LEVEL_THEME[level as LogLevel].chartColor],
      }))
      .sort((a, b) => b.value - a.value)
  }, [logs, themeColors, t])

  // Module activity data
  const moduleData = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const log of logs) {
      counts[log.module] = (counts[log.module] || 0) + 1
    }
    return Object.entries(counts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
  }, [logs])

  // Volume timeline data
  const volumeData = useMemo(() => computeVolumeBuckets(logs, locale), [logs, locale])
  const errorTrendData = useMemo(() => computeErrorTrendData(volumeData), [volumeData])

  // Summary stats
  const stats = useMemo(() => {
    const errorCount = logs.filter((l) => l.level === "error" || l.level === "fatal").length
    const warnCount = logs.filter((l) => l.level === "warn").length
    const errorRate = logs.length > 0 ? errorCount / logs.length : 0
    const warnRate = logs.length > 0 ? warnCount / logs.length : 0

    const moduleCounts: Record<string, number> = {}
    const traceIds = new Set<string>()
    for (const log of logs) {
      moduleCounts[log.module] = (moduleCounts[log.module] || 0) + 1
      if (log.traceId) traceIds.add(log.traceId)
    }
    const topModule = Object.entries(moduleCounts).sort((a, b) => b[1] - a[1])[0]
    const uniqueModules = Object.keys(moduleCounts).length
    const uniqueTraces = traceIds.size

    // The unit comes from the message bundle ("3.0 h" / "3.0 小时"); the
    // number keeps one decimal above an hour so a 25-hour window does not
    // read as "1 day".
    let timeSpan = ""
    if (logs.length > 0) {
      const sorted = logs.map((l) => new Date(l.timestamp).getTime()).sort((a, b) => a - b)
      const diffMs = sorted[sorted.length - 1] - sorted[0]
      const diffHours = diffMs / (1000 * 60 * 60)
      if (diffHours < 1) {
        timeSpan = t("dashboard.spanMinutes", { value: Math.round(diffMs / (1000 * 60)) })
      } else if (diffHours < 24) {
        timeSpan = t("dashboard.spanHours", { value: diffHours.toFixed(1) })
      } else {
        timeSpan = t("dashboard.spanDays", { value: (diffHours / 24).toFixed(1) })
      }
    }

    // Error trend: compare last-quarter error rate vs first-three-quarters
    let errorTrend: "up" | "down" | "stable" = "stable"
    if (volumeData.length >= 4) {
      const splitAt = Math.floor(volumeData.length * 0.75)
      const earlyErrors = volumeData.slice(0, splitAt).reduce((sum, b) => sum + b.error, 0)
      const earlyTotal = volumeData
        .slice(0, splitAt)
        .reduce((sum, b) => sum + b.info + b.warn + b.error + b.other, 0)
      const lateErrors = volumeData.slice(splitAt).reduce((sum, b) => sum + b.error, 0)
      const lateTotal = volumeData
        .slice(splitAt)
        .reduce((sum, b) => sum + b.info + b.warn + b.error + b.other, 0)

      const earlyRate = earlyTotal > 0 ? earlyErrors / earlyTotal : 0
      const lateRate = lateTotal > 0 ? lateErrors / lateTotal : 0

      if (lateRate > earlyRate * 1.5 && lateErrors >= 2) errorTrend = "up"
      else if (earlyRate > lateRate * 1.5 && earlyErrors >= 2) errorTrend = "down"
    }

    return {
      errorCount,
      warnCount,
      errorRate,
      warnRate,
      topModule,
      timeSpan,
      uniqueModules,
      uniqueTraces,
      errorTrend,
    }
  }, [logs, volumeData, t])

  // Top errors: group error-level logs by message prefix
  const topErrors = useMemo(() => {
    const errorLogs = logs.filter((l) => l.level === "error" || l.level === "fatal")
    if (errorLogs.length === 0) return []

    const groups: Record<string, { message: string; count: number }> = {}
    for (const log of errorLogs) {
      const key = log.message.slice(0, 80)
      if (groups[key]) {
        groups[key].count++
      } else {
        groups[key] = { message: key, count: 1 }
      }
    }
    return Object.values(groups)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
  }, [logs])

  if (logs.length === 0) {
    return (
      <div
        className={cn("flex items-center justify-center py-12 text-muted-foreground", className)}
      >
        <p className="text-sm">{t("dashboard.noData")}</p>
      </div>
    )
  }

  return (
    <div className={cn("space-y-4 p-4", className)}>
      {/* Summary Cards — responsive 1 → 2 → 3 → 4 columns */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        <StatCard
          icon={Layers}
          label={t("dashboard.totalLogs")}
          value={format.number(logs.length)}
          color="bg-chart-3/10 text-chart-3"
        />
        <StatCard
          icon={AlertTriangle}
          label={t("dashboard.errorRate")}
          value={percent(stats.errorRate)}
          sub={t("dashboard.errorCount", { count: stats.errorCount })}
          color="bg-destructive/10 text-destructive"
          trend={stats.errorTrend}
          data-testid="dashboard-stat-errors"
          onClick={onLevelFilter && stats.errorCount > 0 ? () => onLevelFilter("error") : undefined}
          actionLabel={t("dashboard.showErrors")}
        />
        <StatCard
          icon={Activity}
          label={t("dashboard.topModule")}
          value={stats.topModule?.[0] || "-"}
          sub={stats.topModule ? t("dashboard.logCount", { count: stats.topModule[1] }) : undefined}
          color="bg-success/10 text-success"
          data-testid="dashboard-stat-top-module"
          onClick={
            onModuleFilter && stats.topModule
              ? () => onModuleFilter(stats.topModule![0])
              : undefined
          }
          actionLabel={t("dashboard.showModule")}
        />
        <StatCard
          icon={Clock}
          label={t("dashboard.timeSpan")}
          value={stats.timeSpan || "-"}
          color="bg-chart-4/10 text-chart-4"
        />
        <StatCard
          icon={Gauge}
          label={t("dashboard.logRate")}
          value={logRate > 0 ? format.number(logRate) : "-"}
          sub={logRate > 0 ? t("dashboard.logsPerMinUnit") : undefined}
          color="bg-chart-2/10 text-chart-2"
        />
        <StatCard
          icon={AlertCircle}
          label={t("dashboard.warningRate")}
          value={percent(stats.warnRate)}
          sub={t("dashboard.warningCount", { count: stats.warnCount })}
          color="bg-warning/10 text-warning"
          data-testid="dashboard-stat-warnings"
          onClick={onLevelFilter && stats.warnCount > 0 ? () => onLevelFilter("warn") : undefined}
          actionLabel={t("dashboard.showWarnings")}
        />
        <StatCard
          icon={Grid3X3}
          label={t("dashboard.uniqueModules")}
          value={format.number(stats.uniqueModules)}
          color="bg-chart-5/10 text-chart-5"
        />
        <StatCard
          icon={Hash}
          label={t("dashboard.uniqueTraces")}
          value={format.number(stats.uniqueTraces)}
          color="bg-chart-1/10 text-chart-1"
        />
      </div>

      {nativeLogging?.runtime === "tauri" && (
        <DashboardSection title={t("dashboard.platformLogging")}>
          <div className="grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-4">
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">{t("dashboard.platformBackend")}</p>
              <p className="font-medium">
                {/* A backend is a product name (OSLog, journald, Event Log)
                    and is printed as reported; "none" is the one word. */}
                {nativeLogging.platformLogging.backend === "none"
                  ? t("dashboard.platformBackendNone")
                  : nativeLogging.platformLogging.backend}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">{t("dashboard.platformHealth")}</p>
              <p className="font-medium">
                {KNOWN_HEALTH.has(nativeLogging.platformLogging.health)
                  ? t(
                      `panel.healthStatus.${nativeLogging.platformLogging.health as "healthy" | "degraded" | "inactive"}`
                    )
                  : nativeLogging.platformLogging.health}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">{t("dashboard.platformThreshold")}</p>
              <p className="font-medium">
                {KNOWN_LEVELS.has(nativeLogging.platformLogging.minLevel)
                  ? t(`levels.${nativeLogging.platformLogging.minLevel}`)
                  : nativeLogging.platformLogging.minLevel}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">{t("dashboard.platformTargets")}</p>
              <p className="font-medium">
                {nativeLogging.activeTargets.length > 0
                  ? nativeLogging.activeTargets.join(", ")
                  : t("panel.nativeLoggingNoTargets")}
              </p>
            </div>
            {nativeLogging.platformLogging.error && (
              <div className="space-y-1 sm:col-span-2 xl:col-span-4">
                <p className="text-xs text-muted-foreground">{t("dashboard.platformError")}</p>
                <p className="text-sm text-destructive">{nativeLogging.platformLogging.error}</p>
              </div>
            )}
          </div>
        </DashboardSection>
      )}

      {/* Charts Row */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* Level Distribution - Pie Chart */}
        <DashboardSection title={t("dashboard.levelDistribution")}>
          <div
            data-testid="dashboard-chart-pie"
            className="w-full h-[180px] sm:h-[200px] md:h-[220px] lg:h-[260px]"
          >
            <ResponsiveContainer
              minWidth={1}
              minHeight={1}
              initialDimension={{ width: 320, height: 180 }}
            >
              <PieChart>
                <Pie
                  data={levelData}
                  cx="50%"
                  cy="50%"
                  innerRadius={50}
                  outerRadius={80}
                  paddingAngle={2}
                  dataKey="value"
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  label={(props: any) =>
                    `${String(props.name ?? "")} ${(((props.percent as number) ?? 0) * 100).toFixed(0)}%`
                  }
                  labelLine={false}
                  onClick={
                    onLevelFilter
                      ? (slice: { payload?: { level?: LogLevel } }) => {
                          if (slice.payload?.level) onLevelFilter(slice.payload.level)
                        }
                      : undefined
                  }
                  className={cn(onLevelFilter && "cursor-pointer")}
                >
                  {levelData.map((entry) => (
                    <Cell key={entry.level} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={TOOLTIP_STYLE.contentStyle}
                  labelStyle={TOOLTIP_STYLE.labelStyle}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
          {/* The same distribution as rows: exact counts (the slices only
              carry a percentage), and a click-through that does not need a
              pointer on a 40px arc. */}
          <ul className="mt-2 space-y-0.5" data-testid="dashboard-level-legend">
            {levelData.map((entry) => (
              <li key={entry.level}>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={!onLevelFilter}
                  className="h-7 w-full justify-start gap-2 px-2 text-xs font-normal disabled:opacity-100"
                  data-testid={`dashboard-level-${entry.level}`}
                  onClick={() => onLevelFilter?.(entry.level)}
                >
                  <span
                    aria-hidden
                    className="size-2 shrink-0 rounded-sm"
                    style={{ backgroundColor: entry.color }}
                  />
                  <span className="flex-1 text-left">{entry.name}</span>
                  <span className="font-mono tabular-nums text-muted-foreground">
                    {format.number(entry.value)}
                  </span>
                </Button>
              </li>
            ))}
          </ul>
        </DashboardSection>

        {/* Log Volume Timeline - Area Chart */}
        <DashboardSection title={t("dashboard.logVolume")} className="lg:col-span-2">
          <div
            data-testid="dashboard-chart-area"
            className="w-full h-[180px] sm:h-[200px] md:h-[220px] lg:h-[260px]"
          >
            <ResponsiveContainer
              minWidth={1}
              minHeight={1}
              initialDimension={{ width: 320, height: 180 }}
            >
              <AreaChart data={volumeData} margin={CHART_MARGINS.default}>
                <defs>
                  <linearGradient id="logVolumeInfo" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={themeColors.success} stopOpacity={0.6} />
                    <stop offset="95%" stopColor={themeColors.success} stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="logVolumeWarn" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={themeColors.warning} stopOpacity={0.6} />
                    <stop offset="95%" stopColor={themeColors.warning} stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="logVolumeError" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={themeColors.destructive} stopOpacity={0.6} />
                    <stop offset="95%" stopColor={themeColors.destructive} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="time" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE.contentStyle}
                  labelStyle={TOOLTIP_STYLE.labelStyle}
                />
                <Legend />
                <Area
                  type="monotone"
                  dataKey="info"
                  stackId="1"
                  stroke={themeColors.success}
                  fill="url(#logVolumeInfo)"
                  name={t("levels.info")}
                />
                <Area
                  type="monotone"
                  dataKey="warn"
                  stackId="1"
                  stroke={themeColors.warning}
                  fill="url(#logVolumeWarn)"
                  name={t("levels.warn")}
                />
                <Area
                  type="monotone"
                  dataKey="error"
                  stackId="1"
                  stroke={themeColors.destructive}
                  fill="url(#logVolumeError)"
                  name={t("levels.error")}
                />
                <Area
                  type="monotone"
                  dataKey="other"
                  stackId="1"
                  stroke={themeColors["muted-foreground"]}
                  fill={themeColors["muted-foreground"]}
                  fillOpacity={0.2}
                  name={t("dashboard.otherSeries")}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </DashboardSection>
      </div>

      {/* Bottom Row: Module Activity + Top Errors */}
      {errorTrendData.length > 0 && (
        <DashboardSection title={t("dashboard.errorTrend")}>
          <div
            data-testid="dashboard-chart-line"
            className="w-full h-[180px] sm:h-[200px] md:h-[220px] lg:h-[260px]"
          >
            <ResponsiveContainer
              minWidth={1}
              minHeight={1}
              initialDimension={{ width: 320, height: 180 }}
            >
              <LineChart data={errorTrendData} margin={CHART_MARGINS.default}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="time" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE.contentStyle}
                  labelStyle={TOOLTIP_STYLE.labelStyle}
                />
                <Legend />
                <Line
                  type="monotone"
                  dataKey="current"
                  stroke={themeColors.destructive}
                  strokeWidth={2}
                  dot={false}
                  name={t("dashboard.currentPeriod")}
                />
                <Line
                  type="monotone"
                  dataKey="previous"
                  stroke={themeColors["muted-foreground"]}
                  strokeWidth={2}
                  strokeDasharray="4 4"
                  dot={false}
                  name={t("dashboard.previousPeriod")}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </DashboardSection>
      )}

      {/* Bottom Row: Module Activity + Top Errors */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Module Activity - Bar Chart */}
        {moduleData.length > 0 && (
          <DashboardSection title={t("dashboard.moduleActivity")}>
            <div
              data-testid="dashboard-chart-bar"
              className="w-full"
              style={{
                height: `clamp(180px, ${moduleData.length * 32}px, 480px)`,
              }}
            >
              <ResponsiveContainer
                minWidth={1}
                minHeight={1}
                initialDimension={{ width: 320, height: 180 }}
              >
                <BarChart
                  data={moduleData}
                  layout="vertical"
                  margin={{ ...CHART_MARGINS.withYAxis, left: 80 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    className="stroke-muted"
                    horizontal={false}
                  />
                  <XAxis type="number" tick={{ fontSize: 11 }} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 12 }} width={75} />
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE.contentStyle}
                    labelStyle={TOOLTIP_STYLE.labelStyle}
                  />
                  <Bar
                    dataKey="count"
                    fill={themeColors["chart-3"]}
                    radius={[0, 4, 4, 0]}
                    name={t("dashboard.logsSeries")}
                    onClick={
                      onModuleFilter
                        ? (bar: { name?: string; payload?: { name?: string } }) => {
                            const moduleName = bar.payload?.name ?? bar.name
                            if (moduleName) onModuleFilter(moduleName)
                          }
                        : undefined
                    }
                    className={cn(onModuleFilter && "cursor-pointer")}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
            {/* The bars are SVG a keyboard cannot reach. The same ranking as
                buttons, hidden until focus enters it, so Tab finds the module
                click-through without the chart printing every count twice. */}
            {onModuleFilter && (
              <ul
                className="sr-only focus-within:not-sr-only focus-within:mt-2 focus-within:space-y-0.5"
                aria-label={t("dashboard.moduleListLabel")}
                data-testid="dashboard-module-list"
              >
                {moduleData.map((entry) => (
                  <li key={entry.name}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 w-full justify-start gap-2 px-2 text-xs font-normal"
                      data-testid={`dashboard-module-${entry.name}`}
                      onClick={() => onModuleFilter(entry.name)}
                    >
                      <span className="flex-1 truncate text-left font-mono">{entry.name}</span>
                      <span className="tabular-nums text-muted-foreground">
                        {format.number(entry.count)}
                      </span>
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </DashboardSection>
        )}

        {/* Top Errors */}
        {topErrors.length > 0 && (
          <DashboardSection title={t("dashboard.topErrors")}>
            <div className="space-y-2">
              {topErrors.map((err, i) => (
                <Button
                  key={i}
                  variant="ghost"
                  className="flex items-start gap-2 w-full justify-start px-2 py-1.5 h-auto text-xs font-normal motion-safe:transition-colors"
                  onClick={() => onSearchFilter?.(err.message)}
                  data-testid={`top-error-${i}`}
                >
                  <Badge variant="destructive" className="text-[10px] shrink-0 mt-0.5">
                    {err.count}
                  </Badge>
                  <span className="text-xs text-muted-foreground break-words line-clamp-2">
                    {err.message}
                  </span>
                </Button>
              ))}
            </div>
          </DashboardSection>
        )}
      </div>
    </div>
  )
}

export default LogStatsDashboard
