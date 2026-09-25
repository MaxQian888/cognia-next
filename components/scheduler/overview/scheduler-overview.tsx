"use client"

/**
 * The overview (ADR-0179 §3): what needs you, then the numbers, then the
 * agenda, then the kinds, then what ran. Sections are `ConsoleSection`
 * cards in the same container-query grid as `/bots`, so the short ones sit
 * beside each other and the agenda takes the width.
 *
 * Every number here is derived once by the page from the same items, runs
 * and signals the list renders, and handed in. This component owns no
 * polling and no store reads.
 */

import { useTranslations } from "next-intl"
import { motion, useReducedMotion } from "motion/react"
import { ActivityIcon, BellIcon, CalendarDaysIcon, HistoryIcon, LayersIcon } from "lucide-react"

import { ConsoleSection } from "@/components/surface/console-section"
import { StatStrip, type StatStripItem } from "@/components/surface/stat-strip"
import { cn } from "@/lib/utils"
import type { Agenda as AgendaData } from "@/lib/scheduler/agenda"
import type { AttentionSignal } from "@/lib/scheduler/attention"
import type { OutcomeCell } from "@/lib/scheduler/outcome-strip"
import { summarizeOutcomeCells } from "@/lib/scheduler/outcome-strip"
import type { UnifiedStatistics } from "@/lib/scheduler/unified-filter"
import type { ScheduledItemKind } from "@/types/scheduler/unified"
import type { UnifiedExecutionRun } from "@/types/scheduler/unified-runs"

import { OutcomeStrip } from "../outcome-strip"
import { RunRow } from "../run-row"
import { listContainerVariants, listItemVariants, staticIf } from "../scheduler-motion"
import { AttentionBlock, type AttentionBlockProps } from "./attention-block"
import { Agenda } from "./agenda"
import { KindSummary } from "./kind-summary"

export interface SchedulerOverviewProps {
  signals: readonly AttentionSignal[]
  statistics: UnifiedStatistics
  outcomeCells: readonly OutcomeCell[]
  agenda: AgendaData
  agendaDays: number
  now: number
  recentRuns: readonly UnifiedExecutionRun[]
  /** How many runs are in flight right now. */
  runningCount: number
  selectedKinds: ReadonlySet<ScheduledItemKind>
  onToggleKind: (kind: ScheduledItemKind) => void
  onSelectItem: (unifiedId: string) => void
  onOpenRun: (run: UnifiedExecutionRun) => void
  onCancelRun?: (run: UnifiedExecutionRun) => void
  attentionActions?: Pick<
    AttentionBlockProps,
    "onCancelRun" | "onRetrySources" | "onSwitchToPaired" | "onOpenPolicy"
  >
  className?: string
}

export const OVERVIEW_RECENT_RUNS = 10

export function SchedulerOverview({
  signals,
  statistics,
  outcomeCells,
  agenda,
  agendaDays,
  now,
  recentRuns,
  runningCount,
  selectedKinds,
  onToggleKind,
  onSelectItem,
  onOpenRun,
  onCancelRun,
  attentionActions,
  className,
}: SchedulerOverviewProps) {
  const t = useTranslations("scheduler.overviewPage")
  const reduceMotion = useReducedMotion()
  const outcome = summarizeOutcomeCells(outcomeCells)

  const stats: StatStripItem[] = [
    {
      id: "active",
      label: t("stat.active"),
      value: statistics.activeItems,
      total: statistics.totalItems,
      tone: statistics.activeItems > 0 ? "positive" : "neutral",
    },
    {
      id: "runs",
      label: t("stat.runs", { days: outcomeCells.length }),
      value: outcome.succeeded + outcome.failed,
      tone: "neutral",
    },
    {
      id: "successRate",
      label: t("stat.successRate"),
      value: outcome.successRate === null ? "—" : `${outcome.successRate}%`,
      tone:
        outcome.successRate === null
          ? "neutral"
          : outcome.successRate >= 90
            ? "positive"
            : outcome.successRate >= 70
              ? "attention"
              : "critical",
    },
    {
      id: "running",
      label: t("stat.running"),
      value: runningCount,
      tone: runningCount > 0 ? "attention" : "neutral",
    },
  ]

  return (
    // Two beats: what needs you, then everything else. The grid moves as one
    // block so each section keeps its own `wide` span.
    <motion.div
      className={cn("@container/console-pane flex min-w-0 flex-col gap-3 p-4", className)}
      data-testid="scheduler-overview"
      variants={staticIf(reduceMotion, listContainerVariants)}
      initial="hidden"
      animate="show"
    >
      <motion.div variants={staticIf(reduceMotion, listItemVariants)} className="min-w-0">
        <ConsoleSection
          id="attention"
          title={t("attentionTitle")}
          icon={BellIcon}
          wide
          meta={signals.length > 0 ? String(signals.length) : undefined}
        >
          <AttentionBlock
            signals={signals}
            next={agenda.next}
            onSelectItem={onSelectItem}
            {...attentionActions}
          />
        </ConsoleSection>
      </motion.div>

      <motion.div
        className="grid gap-3 @3xl/console-pane:grid-cols-2"
        variants={staticIf(reduceMotion, listItemVariants)}
      >
        <ConsoleSection id="outcomes" title={t("outcomesTitle")} icon={ActivityIcon} wide>
          <StatStrip
            stats={stats}
            testId="scheduler-overview-stats"
            cellTestIdPrefix="scheduler-stat"
          />
          <OutcomeStrip
            cells={outcomeCells}
            className="mt-3"
            testId="scheduler-overview-outcomes"
          />
        </ConsoleSection>

        <ConsoleSection
          id="agenda"
          title={t("agendaTitle", { days: agendaDays })}
          icon={CalendarDaysIcon}
          wide
          meta={agenda.occurrences.length > 0 ? String(agenda.occurrences.length) : undefined}
        >
          <Agenda agenda={agenda} windowDays={agendaDays} now={now} onSelectItem={onSelectItem} />
        </ConsoleSection>

        <ConsoleSection id="kinds" title={t("kindsTitle")} icon={LayersIcon}>
          <KindSummary
            statistics={statistics}
            selectedKinds={selectedKinds}
            onToggleKind={onToggleKind}
          />
        </ConsoleSection>

        <ConsoleSection
          id="recent-runs"
          title={t("recentRunsTitle")}
          icon={HistoryIcon}
          meta={
            recentRuns.length > 0
              ? String(Math.min(recentRuns.length, OVERVIEW_RECENT_RUNS))
              : undefined
          }
        >
          {recentRuns.length === 0 ? (
            <p className="text-xs text-muted-foreground" data-testid="scheduler-overview-no-runs">
              {t("noRuns")}
            </p>
          ) : (
            <div className="flex flex-col" data-testid="scheduler-overview-runs">
              {recentRuns.slice(0, OVERVIEW_RECENT_RUNS).map((run) => (
                <RunRow
                  key={run.unifiedId}
                  run={run}
                  onOpen={onOpenRun}
                  onCancel={onCancelRun}
                  showItem
                />
              ))}
            </div>
          )}
        </ConsoleSection>
      </motion.div>
    </motion.div>
  )
}
