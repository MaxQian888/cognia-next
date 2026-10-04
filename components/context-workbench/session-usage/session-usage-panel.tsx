"use client"

/**
 * The conversation's "Usage & context" dock panel: everything about what this
 * conversation is spending and what is filling its window, drawn rather than
 * listed.
 *
 *  - **Context window** — occupancy and auto-compaction (the composer ring's
 *    own header), the composition ring, the per-group detail list, and the
 *    compact-now action.
 *  - **Context growth** — the window across every turn, against the model's
 *    limit and the compaction threshold.
 *  - **Cost per turn** — the shared `SessionCostTimeline`: cost bars, the
 *    priciest turns (each a jump back into the transcript) and this
 *    conversation's rank among recent ones.
 *  - **Token mix**, **tool calls**, **models** and **efficiency** (cache
 *    savings and per-turn percentiles, the shared `UsageEfficiencyPanel`).
 *
 * Nothing is computed here. The window comes from `useSessionContextWindow`
 * (the same resolution as the composer ring), everything else from
 * `analyzeSession` via `useSessionReport` (the same report the Session Insights
 * sheet shows), and the full health report is one click away in that sheet.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import type { UIMessage } from "ai"
import type { ChatSession } from "@cognia/agent-config-types"
import {
  ChartLineIcon,
  CoinsIcon,
  CpuIcon,
  GaugeIcon,
  LayersIcon,
  PiggyBankIcon,
  RefreshCwIcon,
  TrendingUpIcon,
  WrenchIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { ContextDetailPanel } from "@/components/chat/context-detail-panel"
import { CompactNowButton, ContextWindowHeader } from "@/components/chat/context-usage-indicator"
import { SessionCostTimeline } from "@/components/chat/session-insights/session-cost-timeline"
import { Kpi } from "@/components/chat/session-insights/session-report-view"
import { SessionInsightsSheet } from "@/components/chat/session-insights/session-insights-sheet"
import { UsageAttributionRow } from "@/components/usage/usage-attribution-row"
import { UsageEfficiencyPanel } from "@/components/usage/usage-efficiency-panel"
import { ContextCompositionDonut } from "@/components/context-workbench/session-usage/context-composition-donut"
import { ContextGrowthChart } from "@/components/context-workbench/session-usage/context-growth-chart"
import { TokenMixBar } from "@/components/context-workbench/session-usage/token-mix-bar"
import { ToolCallsChart } from "@/components/context-workbench/session-usage/tool-calls-chart"
import { useSessionReport } from "@/hooks/analysis/use-session-report"
import {
  useSessionContextWindow,
  type SessionContextWindow,
} from "@/hooks/chat/use-session-context-window"
import { useSessionCostRank } from "@/hooks/usage/use-session-cost-rank"
import { rankToolCounts, type SessionReport } from "@/lib/analysis/session-report"
import type { SessionUsageSummary } from "@/lib/usage/session-analytics"
import { formatBucketCost } from "@/lib/usage/session-analytics"
import type { SessionCostRank } from "@/lib/usage/session-cost-profile"
import { useChatViewportStore } from "@/stores/chat/chat-viewport-store"
import {
  cacheHitRate,
  formatPercent,
  formatTokens,
  formatTokensPerSec,
  tokensPerSecond,
} from "@/types/system/usage"

export const SESSION_USAGE_PANEL_ID = "session-usage"

const percent = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0, style: "percent" })

export interface SessionUsagePanelProps {
  session: Pick<ChatSession, "id" | "title" | "model" | "providerOverride">
  /** The dock's live transcript; the window's latest usage is read off it. */
  messages: readonly UIMessage[]
}

export function SessionUsagePanel({ session, messages }: SessionUsagePanelProps) {
  const tJump = useTranslations("chat.jump")
  const { report, loading } = useSessionReport(session.id, { title: session.title })
  const context = useSessionContextWindow({
    sessionId: session.id,
    messages,
    modelId: session.model,
    providerId: session.providerOverride,
  })
  // A clock anchor for the rank's day window; a panel left open across
  // midnight keeps yesterday's peers, which is harmless for a percentile.
  const [openedAt] = useState(() => Date.now())
  const target = useMemo<SessionUsageSummary | null>(
    () =>
      report && report.turns > 0
        ? {
            sessionId: session.id,
            turns: report.turns,
            tokens:
              report.totalInputTokens + report.totalOutputTokens + report.totalCacheReadTokens,
            inputTokens: report.totalInputTokens,
            outputTokens: report.totalOutputTokens,
            costUsd: report.totalCostUsd,
            unpricedTurns: report.unpricedTurns,
          }
        : null,
    [report, session.id]
  )
  const rank = useSessionCostRank(target, openedAt)
  const jumpToMessage = useChatViewportStore((s) => s.jumpToMessage)
  const [insightsOpen, setInsightsOpen] = useState(false)

  const onJump = jumpToMessage
    ? (messageId: string) => {
        if (!jumpToMessage(messageId, undefined, { align: "center" })) {
          toast.error(tJump("notFound"))
        }
      }
    : undefined

  return (
    <>
      <SessionUsagePanelView
        sessionId={session.id}
        report={report}
        loading={loading}
        context={context}
        rank={rank}
        onJump={onJump}
        onOpenReport={() => setInsightsOpen(true)}
      />
      {insightsOpen ? (
        <SessionInsightsSheet
          session={session}
          open={insightsOpen}
          onOpenChange={setInsightsOpen}
        />
      ) : null}
    </>
  )
}

export interface SessionUsagePanelViewProps {
  sessionId: string
  report: SessionReport | null
  loading: boolean
  context: SessionContextWindow
  rank: SessionCostRank | null
  onJump?: (messageId: string) => void
  onOpenReport?: () => void
}

/** Presentational half: every figure arrives computed. Exported for stories and tests. */
export function SessionUsagePanelView({
  sessionId,
  report,
  loading,
  context,
  rank,
  onJump,
  onOpenReport,
}: SessionUsagePanelViewProps) {
  const t = useTranslations("contextWorkbench.sessionUsage")
  const [detailOpen, setDetailOpen] = useState(false)
  const [expanded, setExpanded] = useState<string[]>([])
  const { win, breakdown, compaction } = context
  const toolRows = useMemo(() => (report ? rankToolCounts(report.toolCounts) : []), [report])

  return (
    <ScrollArea className="h-full">
      <div className="@container min-w-0 space-y-5 p-4" data-testid="session-usage-panel">
        <header className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">{t("title")}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{t("description")}</p>
          </div>
          {onOpenReport ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0 gap-1.5"
              onClick={onOpenReport}
              data-testid="session-usage-open-report"
            >
              <ChartLineIcon className="size-3.5" aria-hidden />
              {t("openReport")}
            </Button>
          ) : null}
        </header>

        {report && report.turns > 0 ? <SessionUsageKpis report={report} /> : null}

        <PanelSection
          icon={GaugeIcon}
          title={t("sections.window")}
          action={
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={context.refresh}
              aria-label={t("refresh")}
              title={t("refresh")}
              data-testid="session-usage-refresh"
            >
              <RefreshCwIcon className="size-3.5" aria-hidden />
            </Button>
          }
          testid="session-usage-window"
        >
          <ContextWindowHeader
            fraction={win.fraction}
            level={win.level}
            used={win.used}
            max={win.max}
            reported={win.reported}
            compaction={compaction}
          />
          {breakdown.groups.length > 0 ? (
            <ContextCompositionDonut
              breakdown={breakdown}
              centerLabel={win.reported ? percent.format(win.fraction) : "—"}
            />
          ) : (
            <p className="text-xs text-muted-foreground" data-testid="session-usage-window-empty">
              {t("windowEmpty")}
            </p>
          )}
          <ContextDetailPanel
            breakdown={breakdown}
            open={detailOpen}
            onOpenChange={setDetailOpen}
            expanded={expanded}
            onExpandedChange={setExpanded}
          />
          <CompactNowButton
            sessionId={sessionId}
            usedTokens={win.used}
            turns={context.assistantTurns}
            supported={!context.agentOwned}
          />
        </PanelSection>

        {loading ? (
          <p className="text-xs text-muted-foreground" data-testid="session-usage-loading">
            {t("loading")}
          </p>
        ) : !report || report.turns === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="session-usage-empty">
            {t("empty")}
          </p>
        ) : (
          <>
            <PanelSection icon={TrendingUpIcon} title={t("sections.growth")}>
              <ContextGrowthChart
                points={report.timeline}
                maxTokens={win.max}
                compactAtTokens={
                  compaction.threshold != null ? Math.round(win.max * compaction.threshold) : null
                }
              />
            </PanelSection>

            <PanelSection icon={CoinsIcon} title={t("sections.cost")}>
              <SessionCostTimeline points={report.timeline} rank={rank} onJump={onJump} hideTitle />
            </PanelSection>

            <PanelSection icon={LayersIcon} title={t("sections.tokenMix")}>
              <TokenMixBar
                mix={{
                  inputTokens: report.totalInputTokens,
                  outputTokens: report.totalOutputTokens,
                  cacheReadTokens: report.totalCacheReadTokens,
                  cacheCreationTokens: report.totalCacheCreationTokens,
                  reasoningTokens: report.totalReasoningTokens,
                }}
              />
            </PanelSection>

            <PanelSection icon={WrenchIcon} title={t("sections.tools")}>
              <ToolCallsChart
                rows={toolRows}
                total={report.toolCallTotal}
                errors={report.errorCount}
              />
            </PanelSection>

            {report.models.length > 1 ? (
              <PanelSection icon={CpuIcon} title={t("sections.models")}>
                <ul className="space-y-2.5" data-testid="session-usage-models">
                  {report.models.map((m) => (
                    <UsageAttributionRow
                      key={m.model}
                      id={m.model}
                      testidPrefix="session-usage-model"
                      label={m.model}
                      pct={
                        report.totalCostUsd > 0
                          ? Math.round((m.costUsd / report.totalCostUsd) * 100)
                          : null
                      }
                      costUsd={m.costUsd}
                      unpricedTurns={m.unpricedTurns}
                      turns={m.turns}
                      detail={t("modelDetail", {
                        turns: m.turns,
                        tokens: formatTokens(m.inputTokens + m.outputTokens + m.cacheReadTokens),
                      })}
                    />
                  ))}
                </ul>
              </PanelSection>
            ) : null}

            <PanelSection icon={PiggyBankIcon} title={t("sections.efficiency")}>
              <UsageEfficiencyPanel
                savings={report.cacheSavings}
                distribution={report.turnDistribution}
                testid="session-usage-efficiency"
              />
            </PanelSection>
          </>
        )}
      </div>
    </ScrollArea>
  )
}

/** Six headline figures in a container-responsive grid. */
function SessionUsageKpis({ report }: { report: SessionReport }) {
  const t = useTranslations("contextWorkbench.sessionUsage.kpi")
  const tokens =
    report.totalInputTokens +
    report.totalOutputTokens +
    report.totalCacheReadTokens +
    report.totalCacheCreationTokens
  const speed = tokensPerSecond(report.totalOutputTokens, report.totalDurationMs)
  const hasCache = report.totalCacheReadTokens + report.totalCacheCreationTokens > 0
  return (
    <div className="grid grid-cols-2 gap-2 @xs:grid-cols-3" data-testid="session-usage-kpis">
      <Kpi
        label={t("cost")}
        value={formatBucketCost(report.totalCostUsd, report.unpricedTurns, report.turns)}
      />
      <Kpi label={t("turns")} value={report.turns} />
      <Kpi label={t("tokens")} value={formatTokens(tokens)} />
      <Kpi
        label={t("cacheHit")}
        value={
          hasCache
            ? formatPercent(
                cacheHitRate(report.totalCacheReadTokens, report.totalCacheCreationTokens)
              )
            : "—"
        }
      />
      <Kpi
        label={t("avgCost")}
        value={formatBucketCost(
          report.totalCostUsd / report.turns,
          report.unpricedTurns,
          report.turns
        )}
      />
      <Kpi
        label={t("speed")}
        value={speed == null ? "—" : t("tokPerSec", { value: formatTokensPerSec(speed) })}
      />
    </div>
  )
}

function PanelSection({
  icon: Icon,
  title,
  action,
  children,
  testid,
}: {
  icon: typeof GaugeIcon
  title: string
  action?: React.ReactNode
  children: React.ReactNode
  testid?: string
}) {
  return (
    <section className="space-y-3 border-t pt-4" aria-label={title} data-testid={testid}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-medium">
          <Icon className="size-4 text-muted-foreground" aria-hidden />
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  )
}
