"use client"

/**
 * Presentational layout for a {@link SessionReport}: KPI tiles, per-turn
 * averages, per-model usage (incl. throughput), the seven health assessments,
 * and a friction/thinking signals panel. Pure props in — the data + memoized
 * analysis come from `useSessionReport`.
 */

import { useTranslations } from "next-intl"

import {
  cacheHitRate,
  formatCostInCurrency,
  formatDuration,
  formatPercent,
  formatTokens,
  formatTokensPerSec,
  tokensPerSecond,
} from "@/types/system/usage"
import type { SessionReport } from "@/lib/analysis/session-report"
import { AssessmentCard } from "@/components/chat/session-insights/assessment-card"

function Kpi({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border p-2">
      <p className="text-[10px] uppercase text-muted-foreground">{label}</p>
      <p className="font-mono text-sm">{value}</p>
    </div>
  )
}

export function SessionReportView({ report }: { report: SessionReport }) {
  const t = useTranslations("sessionInsights")
  const totalTokens =
    report.totalInputTokens +
    report.totalOutputTokens +
    report.totalCacheReadTokens +
    report.totalCacheCreationTokens

  // Throughput = summed output tokens ÷ summed active generation time. `null`
  // when no turn reported a duration (non-SDK paths) → "—" placeholder.
  const speed = tokensPerSecond(report.totalOutputTokens, report.totalDurationMs)
  const speedLabel =
    speed != null ? t("units.tokPerSec", { value: formatTokensPerSec(speed) }) : "—"
  const durationLabel = report.totalDurationMs > 0 ? formatDuration(report.totalDurationMs) : "—"
  const reasoningLabel =
    report.totalReasoningTokens > 0 ? formatTokens(report.totalReasoningTokens) : "—"
  const hasCache = report.totalCacheReadTokens + report.totalCacheCreationTokens > 0
  const cacheHitLabel = hasCache
    ? formatPercent(cacheHitRate(report.totalCacheReadTokens, report.totalCacheCreationTokens))
    : "—"

  const turns = report.turns
  const avgTokens = turns > 0 ? formatTokens(Math.round(totalTokens / turns)) : "—"
  const avgCost = turns > 0 ? formatCostInCurrency(report.totalCostUsd / turns) : "—"
  const avgDuration =
    turns > 0 && report.totalDurationMs > 0 ? formatDuration(report.totalDurationMs / turns) : "—"

  return (
    <div className="space-y-4" data-testid="session-report-view">
      {/* KPI tiles */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Kpi label={t("kpi.turns")} value={report.turns} />
        <Kpi label={t("kpi.tokens")} value={formatTokens(totalTokens)} />
        <Kpi label={t("kpi.cost")} value={formatCostInCurrency(report.totalCostUsd)} />
        <Kpi label={t("kpi.speed")} value={speedLabel} />
        <Kpi label={t("kpi.duration")} value={durationLabel} />
        <Kpi label={t("kpi.reasoning")} value={reasoningLabel} />
        <Kpi label={t("kpi.cacheHit")} value={cacheHitLabel} />
        <Kpi label={t("kpi.tools")} value={report.toolCallTotal} />
        <Kpi label={t("kpi.errors")} value={report.errorCount} />
        <Kpi label={t("kpi.denials")} value={report.denialCount} />
        <Kpi label={t("kpi.modelSwitches")} value={report.modelSwitches.length} />
        <Kpi label={t("kpi.idleGaps")} value={report.idleGaps.length} />
      </div>

      {/* Per-turn averages */}
      {turns > 0 && (
        <section className="space-y-1.5" data-testid="averages-panel">
          <p className="text-[10px] uppercase text-muted-foreground">{t("averages.title")}</p>
          <div className="grid grid-cols-3 gap-2">
            <Kpi label={t("averages.tokens")} value={avgTokens} />
            <Kpi label={t("averages.cost")} value={avgCost} />
            <Kpi label={t("averages.duration")} value={avgDuration} />
          </div>
        </section>
      )}

      {/* Per-model usage */}
      {report.models.length > 0 && (
        <section className="space-y-1.5">
          <p className="text-[10px] uppercase text-muted-foreground">{t("models.title")}</p>
          {report.models.map((m) => {
            const modelSpeed = tokensPerSecond(m.outputTokens, m.durationMs)
            return (
              <div
                key={m.model}
                className="flex items-center justify-between gap-3 text-xs"
                data-testid="model-row"
              >
                <span className="truncate">{m.model}</span>
                <span className="shrink-0 font-mono text-muted-foreground">
                  {formatTokens(m.inputTokens + m.outputTokens + m.cacheReadTokens)} ·{" "}
                  {formatCostInCurrency(m.costUsd)}
                  {modelSpeed != null && (
                    <> · {t("units.tokPerSec", { value: formatTokensPerSec(modelSpeed) })}</>
                  )}
                </span>
              </div>
            )
          })}
        </section>
      )}

      {/* Health assessments */}
      <section className="space-y-1.5">
        <p className="text-[10px] uppercase text-muted-foreground">{t("assessments.title")}</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {report.assessments.map((a) => (
            <AssessmentCard key={a.id} assessment={a} />
          ))}
        </div>
      </section>

      {/* Friction / thinking signals */}
      <section className="space-y-1.5">
        <p className="text-[10px] uppercase text-muted-foreground">{t("signals.title")}</p>
        <ul className="space-y-1 text-xs text-muted-foreground" data-testid="signals-panel">
          {report.frictionTotal > 0 && (
            <li>{t("signals.friction", { count: report.frictionTotal })}</li>
          )}
          {report.thinkingCount > 0 && (
            <li>{t("signals.thinking", { count: report.thinkingCount })}</li>
          )}
          {report.testSnapshots.length > 0 && (
            <li>
              {t("signals.tests", {
                passed: report.testSnapshots.reduce((a, s) => a + s.passed, 0),
                failed: report.testSnapshots.reduce((a, s) => a + s.failed, 0),
              })}
            </li>
          )}
          {report.frictionTotal === 0 && report.thinkingCount === 0 && (
            <li>{t("signals.empty")}</li>
          )}
        </ul>
      </section>

      {report.degraded && <p className="text-[10px] text-muted-foreground">{t("degradedTree")}</p>}
    </div>
  )
}
