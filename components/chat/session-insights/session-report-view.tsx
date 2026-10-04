"use client"

/**
 * Presentational layout for a {@link SessionReport}: KPI tiles, per-turn
 * averages, the per-turn cost timeline (with the priciest turns and this
 * conversation's rank among recent ones), per-model usage (incl. throughput),
 * cache savings and per-turn percentiles, the seven health assessments, and a
 * friction/thinking signals panel. Pure props in — the data + memoized
 * analysis come from `useSessionReport`, the rank from `useSessionCostRank`.
 *
 * Costs go through `formatBucketCost`, so a session holding turns nobody could
 * price reads as a lower bound here exactly as it does on the Usage dashboard.
 */

import { useTranslations } from "next-intl"

import {
  cacheHitRate,
  formatDuration,
  formatPercent,
  formatTokens,
  formatTokensPerSec,
  tokensPerSecond,
} from "@/types/system/usage"
import type { SessionReport } from "@/lib/analysis/session-report"
import { formatBucketCost } from "@/lib/usage/session-analytics"
import type { SessionCostRank } from "@/lib/usage/session-cost-profile"
import { AssessmentCard } from "@/components/chat/session-insights/assessment-card"
import { SessionCostTimeline } from "@/components/chat/session-insights/session-cost-timeline"
import { UsageEfficiencyPanel } from "@/components/usage/usage-efficiency-panel"
import { SkillSuggestionCard } from "@/components/chat/skill-suggestion-card"
import {
  TestResults,
  TestResultsContent,
  TestResultsHeader,
  TestResultsSummary,
  TestSuiteStats,
} from "@/components/ai-elements/test-results"

/** One labelled figure. Shared with the Usage & context dock panel. */
export function Kpi({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border p-2">
      <p className="text-[10px] uppercase text-muted-foreground">{label}</p>
      <p className="font-mono text-sm">{value}</p>
    </div>
  )
}

export function SessionReportView({
  report,
  sessionId,
  rank = null,
  onJumpToMessage,
}: {
  report: SessionReport
  sessionId?: string
  /** This session's cost rank among recent ones, when there are enough peers. */
  rank?: SessionCostRank | null
  /** Jump back to a turn in the transcript; the priciest-turns list uses it. */
  onJumpToMessage?: (messageId: string) => void
}) {
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
  const avgCost =
    turns > 0 ? formatBucketCost(report.totalCostUsd / turns, report.unpricedTurns, turns) : "—"
  const avgDuration =
    turns > 0 && report.totalDurationMs > 0 ? formatDuration(report.totalDurationMs / turns) : "—"
  const passedTests = report.testSnapshots.reduce((sum, snapshot) => sum + snapshot.passed, 0)
  const failedTests = report.testSnapshots.reduce((sum, snapshot) => sum + snapshot.failed, 0)

  return (
    <div className="space-y-4" data-testid="session-report-view">
      {sessionId ? (
        <SkillSuggestionCard
          source={{ kind: "session", sessionId }}
          outcome={{
            completed: true,
            turns: report.turns,
            errorCount: report.errorCount,
            denialCount: report.denialCount,
            toolCallTotal: report.toolCallTotal,
            passedTests,
            failedTests,
            commitCount: report.commitCount,
          }}
        />
      ) : null}
      {/* KPI tiles */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Kpi label={t("kpi.turns")} value={report.turns} />
        <Kpi label={t("kpi.tokens")} value={formatTokens(totalTokens)} />
        <Kpi
          label={t("kpi.cost")}
          value={formatBucketCost(report.totalCostUsd, report.unpricedTurns, report.turns)}
        />
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

      <SessionCostTimeline points={report.timeline} rank={rank} onJump={onJumpToMessage} />

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
                  {formatBucketCost(m.costUsd, m.unpricedTurns, m.turns)}
                  {modelSpeed != null && (
                    <> · {t("units.tokPerSec", { value: formatTokensPerSec(modelSpeed) })}</>
                  )}
                </span>
              </div>
            )
          })}
        </section>
      )}

      {turns > 0 && (
        <section className="space-y-1.5">
          <p className="text-[10px] uppercase text-muted-foreground">{t("efficiency.title")}</p>
          <UsageEfficiencyPanel
            savings={report.cacheSavings}
            distribution={report.turnDistribution}
            testid="session-efficiency"
          />
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

      {report.testSnapshots.length > 0 && (
        <TestResults
          data-testid="session-test-results"
          summary={{
            passed: passedTests,
            failed: failedTests,
            skipped: 0,
            total: report.testSnapshots.reduce(
              (sum, snapshot) => sum + snapshot.passed + snapshot.failed,
              0
            ),
          }}
        >
          <TestResultsHeader>
            <TestResultsSummary>
              <span className="text-sm font-medium">{t("tests.title")}</span>
            </TestResultsSummary>
          </TestResultsHeader>
          <TestResultsContent>
            {report.testSnapshots.map((snapshot) => (
              <div
                className="flex items-center gap-3 rounded-lg border px-4 py-3"
                data-testid={`session-test-snapshot-${snapshot.messageIndex}`}
                key={snapshot.messageIndex}
              >
                <span className="min-w-0 flex-1 text-sm font-medium">
                  {t("tests.snapshot", { index: snapshot.messageIndex + 1 })}
                </span>
                <TestSuiteStats>
                  <span className={snapshot.failed > 0 ? "text-destructive" : "text-success"}>
                    {t("tests.counts", { passed: snapshot.passed, failed: snapshot.failed })}
                  </span>
                </TestSuiteStats>
              </div>
            ))}
          </TestResultsContent>
        </TestResults>
      )}

      {report.degraded && <p className="text-[10px] text-muted-foreground">{t("degradedTree")}</p>}
    </div>
  )
}
