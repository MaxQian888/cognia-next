"use client"

/**
 * Stats bar surfaced above the /logs Agent Trace tab. Aggregates persisted
 * spans across the chosen time window and shows the headline numbers
 * (cost, tokens, cache hit rate, error rate) plus a per-model breakdown.
 *
 * Data lives in Dexie (the trace transport persists every finished span);
 * the live query refreshes whenever a new span lands. The component itself
 * is pure presentation — pass `summary === null` for the loading state.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"

import { cn } from "@/lib/utils"
import { aggregateStatsAll, type AgentTraceStatsSummary } from "@/lib/db/agent-traces"

export type AgentTraceStatsWindow = "today" | "week" | "month" | "all"

interface AgentTraceStatsBarProps {
  window?: AgentTraceStatsWindow
  className?: string
}

/** Live-query wrapper. Picks up new spans without polling. */
export function AgentTraceStatsBar({ window = "today", className }: AgentTraceStatsBarProps) {
  const since = useMemo(() => windowToSince(window), [window])
  const summary = useLiveQuery(
    () => aggregateStatsAll(since !== undefined ? { since } : undefined),
    [since],
    undefined as AgentTraceStatsSummary | undefined
  )
  return <AgentTraceStatsBarView summary={summary ?? null} window={window} className={className} />
}

interface AgentTraceStatsBarViewProps {
  summary: AgentTraceStatsSummary | null
  window: AgentTraceStatsWindow
  className?: string
}

/** Pure rendering surface — splits from the hook wrapper so unit tests can
 * supply a fixed summary without touching Dexie. */
export function AgentTraceStatsBarView({
  summary,
  window,
  className,
}: AgentTraceStatsBarViewProps) {
  const t = useTranslations("logging.panel.agentTrace.statsBar")

  if (!summary) {
    return (
      <div
        role="status"
        aria-label={t("loading")}
        className={cn(
          "rounded-md border border-dashed bg-muted/30 p-3 text-xs text-muted-foreground",
          className
        )}
      >
        {t("loading")}
      </div>
    )
  }

  const cards: Array<{ label: string; value: string; hint?: string }> = [
    {
      label: t("totalCost"),
      value: formatUsd(summary.totalCost),
      hint: t("totalSpansHint", { count: summary.totalSpans }),
    },
    {
      label: t("inputTokens"),
      value: formatNumber(summary.totalInputTokens),
      hint: t("outputHint", { count: summary.totalOutputTokens }),
    },
    {
      label: t("cacheHitRate"),
      value: formatPercent(summary.cacheHitRate),
      hint: t("cacheReadHint", { count: summary.totalCacheReadTokens }),
    },
    {
      label: t("toolCalls"),
      value: formatNumber(summary.toolCallCount),
      hint: t("toolFailuresHint", { count: summary.toolFailureCount }),
    },
    {
      label: t("errors"),
      value: formatNumber(summary.errorCount),
      hint: t("avgLatencyHint", { ms: Math.round(summary.avgLatencyMs) }),
    },
  ]

  const modelEntries = Object.entries(summary.byModel)
    .filter(([key]) => key !== "(unknown)")
    .sort((a, b) => b[1].costUsd - a[1].costUsd)
    .slice(0, 4)

  return (
    <section
      aria-label={t("regionLabel", { window: t(`windows.${window}`) })}
      className={cn("flex flex-col gap-2", className)}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {t("title")}
        </h3>
        <span className="text-xs text-muted-foreground" data-testid="agent-trace-stats-window">
          {t(`windows.${window}`)}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {cards.map((c) => (
          <div
            key={c.label}
            className="rounded-md border bg-card p-2.5"
            data-testid={`agent-trace-stats-${slugify(c.label)}`}
          >
            <div className="text-xs text-muted-foreground">{c.label}</div>
            <div className="text-base font-semibold tabular-nums">{c.value}</div>
            {c.hint && <div className="text-[10px] text-muted-foreground">{c.hint}</div>}
          </div>
        ))}
      </div>
      {modelEntries.length > 0 && (
        <ul
          className="flex flex-wrap gap-1.5 text-xs text-muted-foreground"
          data-testid="agent-trace-stats-by-model"
        >
          {modelEntries.map(([model, m]) => (
            <li key={model} className="rounded border bg-muted/40 px-1.5 py-0.5">
              <span className="font-medium text-foreground">{model}</span>
              <span className="ml-1 tabular-nums">{formatUsd(m.costUsd)}</span>
              <span className="ml-1 text-[10px]">·{formatNumber(m.spans)} runs</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function windowToSince(window: AgentTraceStatsWindow): number | undefined {
  const now = Date.now()
  switch (window) {
    case "today": {
      const d = new Date(now)
      d.setHours(0, 0, 0, 0)
      return d.getTime()
    }
    case "week":
      return now - 7 * 24 * 60 * 60 * 1000
    case "month":
      return now - 30 * 24 * 60 * 60 * 1000
    case "all":
      return undefined
  }
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "$0.00"
  if (value < 0.01) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "0"
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(Math.round(value))
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "0%"
  return `${Math.round(value * 100)}%`
}

function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
}
