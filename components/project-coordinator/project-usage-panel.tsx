"use client"

/**
 * One workspace's spend (ADR-0204): its own budget ceilings, the trailing
 * window's total, the daily heatmap, and where the money went by conversation
 * and by model. Every piece is a mount of what the Usage dashboard already
 * draws — the budget meters, the heatmap, the shared aggregators — narrowed to
 * the rows this workspace's sessions recorded.
 */

import Link from "next/link"
import { useNow, useTranslations } from "next-intl"
import { BarChart3Icon, WalletIcon } from "lucide-react"
import { ConsoleSection } from "@/components/surface/console-section"
import { Skeleton } from "@/components/ui/skeleton"
import { UsageBudgetMeters } from "@/components/usage/usage-budget-meters"
import { UsageHeatmap } from "@/components/usage/usage-heatmap"
import { useProjectUsage } from "@/hooks/project-coordinator/use-project-usage"
import { sessionHref } from "@/lib/issues/run/agent-task-adapter"
import { formatBucketCost } from "@/lib/usage/session-analytics"
import { formatTokens } from "@/types/system/usage"

export const PROJECT_USAGE_RANGE_DAYS = 30
const TOP_ROWS = 8

export interface ProjectUsagePanelProps {
  projectId: string
}

export function ProjectUsagePanel({ projectId }: ProjectUsagePanelProps) {
  const t = useTranslations("projectCoordinator.usage")
  // Hourly is plenty: the window is whole days and the live query reacts to
  // new rows on its own; the clock only has to notice midnight.
  const now = useNow({ updateInterval: 3_600_000 }).getTime()
  const usage = useProjectUsage(projectId, PROJECT_USAGE_RANGE_DAYS, now)

  return (
    <div className="@container/workspace-pane flex flex-col gap-3.5" data-testid="project-usage">
      <ConsoleSection
        id="project-budget"
        pane="workspace-pane"
        idPrefix="workspace-section"
        icon={WalletIcon}
        title={t("budget.title")}
        wide
      >
        <UsageBudgetMeters projectId={projectId} emptyHint={t("budget.empty")} />
      </ConsoleSection>

      <ConsoleSection
        id="project-spend"
        pane="workspace-pane"
        idPrefix="workspace-section"
        icon={BarChart3Icon}
        title={t("spend.title", { days: PROJECT_USAGE_RANGE_DAYS })}
        wide
      >
        {usage === undefined ? (
          <div role="status" aria-busy="true" aria-label={t("loading")} className="space-y-2">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : usage.totals.turns === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="project-usage-empty">
            {t("spend.empty")}
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            <dl className="grid grid-cols-3 gap-3 text-xs" data-testid="project-usage-totals">
              <Figure
                label={t("spend.cost")}
                value={formatBucketCost(
                  usage.totals.costUsd,
                  usage.totals.unpricedTurns,
                  usage.totals.turns
                )}
              />
              <Figure label={t("spend.turns")} value={String(usage.totals.turns)} />
              <Figure label={t("spend.tokens")} value={formatTokens(usage.totals.tokens)} />
            </dl>
            <UsageHeatmap
              daily={usage.daily}
              rangeDays={PROJECT_USAGE_RANGE_DAYS}
              now={now}
              testIdPrefix="project-usage-heatmap"
            />
            <div className="grid gap-4 @3xl/workspace-pane:grid-cols-2">
              <section aria-label={t("bySession.title")}>
                <h4 className="mb-1.5 text-xs font-medium">{t("bySession.title")}</h4>
                <ul className="space-y-1" data-testid="project-usage-sessions">
                  {usage.bySession.slice(0, TOP_ROWS).map((row) => {
                    const session = usage.sessions.get(row.sessionId)
                    const role = session?.projectRole
                    return (
                      <li
                        key={row.sessionId}
                        className="flex items-baseline justify-between gap-2 text-xs"
                      >
                        <Link
                          href={sessionHref(row.sessionId)}
                          className="min-w-0 truncate hover:underline"
                        >
                          {session?.title || t("bySession.untitled")}
                          {role ? (
                            <span className="ml-1.5 text-muted-foreground">
                              {t(`bySession.role.${role}`)}
                            </span>
                          ) : null}
                        </Link>
                        <span className="shrink-0 font-mono tabular-nums">
                          {formatBucketCost(row.costUsd, row.unpricedTurns, row.turns)}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              </section>
              <section aria-label={t("byModel.title")}>
                <h4 className="mb-1.5 text-xs font-medium">{t("byModel.title")}</h4>
                <ul className="space-y-1" data-testid="project-usage-models">
                  {usage.byModel.slice(0, TOP_ROWS).map((row) => (
                    <li
                      key={row.model}
                      className="flex items-baseline justify-between gap-2 text-xs"
                    >
                      <span className="min-w-0 truncate font-mono">{row.model}</span>
                      <span className="shrink-0 font-mono tabular-nums">
                        {formatBucketCost(row.costUsd, row.unpricedTurns, row.turns)}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            </div>
          </div>
        )}
      </ConsoleSection>
    </div>
  )
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate font-mono text-sm tabular-nums">{value}</dd>
    </div>
  )
}
