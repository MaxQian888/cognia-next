"use client"

/**
 * Stats bar surfaced above the /logs Agent Trace tab. Aggregates persisted
 * spans across the chosen time window and shows the headline numbers
 * (cost, tokens, cache hit rate, error rate) plus a per-model breakdown.
 *
 * Data lives in Dexie (the trace transport persists every finished span);
 * the live query refreshes whenever a new span lands. The component itself
 * is pure presentation — pass `summary === null` for the loading state.
 *
 * Every card has a fixed `id`, and its test id is built from THAT. It used to
 * be a slug of the translated label, so the ids were `agent-trace-stats-cost`
 * in English and an empty `agent-trace-stats-` in Chinese (the slugger only
 * kept ASCII) — selectors broke the moment the locale changed. Values format
 * in the app locale; the grid steps by its container, not the viewport.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"

import { cn } from "@/lib/utils"
import { useObservabilityFormatters } from "@/hooks/observability/use-observability-formatters"
import { aggregateStatsAll, type AgentTraceStatsSummary } from "@/lib/db/agent-traces"
import { agentTraceWindowSince } from "@/lib/observability/trace-window"
import type { AgentTraceStatsWindow } from "@/lib/observability/trace-window"

// Re-exported so the many existing `AgentTraceStatsWindow` imports keep working
// now that the mapping itself moved to `lib/observability/trace-window.ts`.
export type { AgentTraceStatsWindow }

interface AgentTraceStatsBarProps {
  window?: AgentTraceStatsWindow
  className?: string
}

/** Live-query wrapper. Picks up new spans without polling. */
export function AgentTraceStatsBar({ window = "today", className }: AgentTraceStatsBarProps) {
  const since = useMemo(() => agentTraceWindowSince(window), [window])
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
  const fmt = useObservabilityFormatters()

  if (!summary) {
    return (
      <div
        role="status"
        aria-label={t("loading")}
        className={cn("border-y border-dashed p-3 text-xs text-muted-foreground", className)}
      >
        {t("loading")}
      </div>
    )
  }

  const cards: Array<{ id: StatsCardId; label: string; value: string; hint?: string }> = [
    {
      id: "total-cost",
      label: t("totalCost"),
      value: fmt.usd(finiteOr0(summary.totalCost)),
      hint: t("totalSpansHint", { count: summary.totalSpans }),
    },
    {
      id: "input-tokens",
      label: t("inputTokens"),
      value: fmt.compact(finiteOr0(summary.totalInputTokens)),
      hint: t("outputHint", { count: fmt.compact(finiteOr0(summary.totalOutputTokens)) }),
    },
    {
      id: "cache-hit-rate",
      label: t("cacheHitRate"),
      value: fmt.percent(finiteOr0(summary.cacheHitRate)),
      hint: t("cacheReadHint", { count: fmt.compact(finiteOr0(summary.totalCacheReadTokens)) }),
    },
    {
      id: "tool-calls",
      label: t("toolCalls"),
      value: fmt.compact(finiteOr0(summary.toolCallCount)),
      hint: t("toolFailuresHint", { count: summary.toolFailureCount }),
    },
    {
      id: "errors",
      label: t("errors"),
      value: fmt.compact(finiteOr0(summary.errorCount)),
      hint: t("avgLatencyHint", { value: fmt.duration(finiteOr0(summary.avgLatencyMs)) }),
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
      <div className="@container">
        <div className="grid grid-cols-2 gap-2 @lg:grid-cols-3 @3xl:grid-cols-5">
          {cards.map((c) => (
            <div
              key={c.id}
              className="border-y bg-background p-2.5"
              data-testid={`agent-trace-stats-${c.id}`}
            >
              <div className="text-xs text-muted-foreground">{c.label}</div>
              <div className="text-base font-semibold tabular-nums">{c.value}</div>
              {c.hint && <div className="text-[10px] text-muted-foreground">{c.hint}</div>}
            </div>
          ))}
        </div>
      </div>
      {modelEntries.length > 0 && (
        <ul
          className="flex flex-wrap gap-1.5 text-xs text-muted-foreground"
          data-testid="agent-trace-stats-by-model"
        >
          {modelEntries.map(([model, m]) => (
            <li key={model} className="border-y px-1.5 py-0.5">
              <span className="font-medium text-foreground">{model}</span>
              <span className="ml-1 tabular-nums">{fmt.usd(finiteOr0(m.costUsd))}</span>
              <span className="ml-1 text-[10px]">·{t("modelRuns", { count: m.spans })}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** Stable card ids — the test-id contract (see the file header). */
export const STATS_CARD_IDS = [
  "total-cost",
  "input-tokens",
  "cache-hit-rate",
  "tool-calls",
  "errors",
] as const
export type StatsCardId = (typeof STATS_CARD_IDS)[number]

function finiteOr0(value: number): number {
  return Number.isFinite(value) ? value : 0
}
