"use client"

/**
 * Mobile companion Goals view (closes the `/goals` desktop-only gap).
 *
 * Read-mostly mirror of the desktop GoalConsole: a StatCard summary strip, a
 * horizontally-scrollable section switcher (Overview / History / Analytics),
 * and rich goal rows that echo the desktop compact card (color rail + status
 * chip + inline progress). Opens the shared `GoalDetailSheet` on tap. Goal
 * authoring / templates / tracker config stay on the desktop.
 *
 * All copy resolves against the `goal` namespace (the desktop console's), so
 * the mobile surface no longer depends on a `mobile.goals` bundle that was
 * never shipped.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { TargetIcon } from "lucide-react"

import { Card } from "@/components/ui/card"
import { EmptyState } from "@/components/mobile/empty-state"
import { PullToRefresh } from "@/components/interactions/pull-to-refresh"
import { GoalDetailSheet } from "@/components/goal/goal-detail-sheet"
import { GoalAnalyticsPanel } from "@/components/goal/analytics/goal-analytics-panel"
import { GoalRunControls } from "@/components/mobile/goals/goal-run-controls"
import { GoalsMobileStatStrip } from "@/components/mobile/goals/goals-mobile-stat-strip"
import {
  GoalsMobileSectionSwitcher,
  type GoalMobileSection,
} from "@/components/mobile/goals/goals-mobile-section-switcher"
import { goalStatusStyle } from "@/components/goal/goal-status-style"
import { listAllGoals } from "@/lib/db/goals"
import { runSyncDown } from "@/lib/sync/companion-sync"
import { isTerminalGoalStatus } from "@/types/goal"
import type { Goal } from "@/types/goal"
import { cn } from "@/lib/utils"

export function GoalsMobileBody() {
  const t = useTranslations("goal")
  const goals = useLiveQuery(() => listAllGoals(), [])
  const [selected, setSelected] = useState<Goal | null>(null)
  const [section, setSection] = useState<GoalMobileSection>("overview")

  const list = useMemo(() => goals ?? [], [goals])
  const stats = useMemo(
    () => ({
      active: list.filter((g) => g.status === "active").length,
      paused: list.filter((g) => g.status === "paused").length,
      done: list.filter((g) => isTerminalGoalStatus(g.status)).length,
    }),
    [list]
  )
  const openGoals = useMemo(
    () => list.filter((g) => g.status === "active" || g.status === "paused"),
    [list]
  )

  const handleRefresh = async (): Promise<void> => {
    try {
      await runSyncDown({ only: ["goals"] })
    } catch {
      // Orchestrator swallows handler-level failures.
    }
  }

  const rows = section === "overview" ? openGoals : list

  return (
    <main
      className="flex min-h-[100dvh] flex-col gap-3 bg-background pt-3 safe-area-pt"
      data-testid="mobile-goals-body"
    >
      <header className="px-4">
        <h1 className="text-2xl font-semibold tracking-tight">{t("console.title")}</h1>
      </header>

      <div className="px-4">
        <GoalsMobileStatStrip active={stats.active} paused={stats.paused} done={stats.done} />
      </div>

      <GoalsMobileSectionSwitcher active={section} onSelect={setSection} />

      <PullToRefresh onRefresh={handleRefresh}>
        <section className="flex flex-col gap-2 px-4 pb-4" data-testid={`mobile-goals-${section}`}>
          {section === "analytics" ? (
            <div className="overflow-x-hidden">
              <GoalAnalyticsPanel goals={list} />
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={TargetIcon}
              title={section === "overview" ? t("console.activeEmpty") : t("history.empty")}
            />
          ) : (
            <ul className="flex flex-col gap-2">
              {rows.map((goal) => (
                <GoalRow key={goal.id} goal={goal} onOpen={() => setSelected(goal)} />
              ))}
            </ul>
          )}
        </section>
      </PullToRefresh>

      {selected ? (
        <GoalDetailSheet
          goal={selected}
          open={!!selected}
          onOpenChange={(open) => {
            if (!open) setSelected(null)
          }}
        />
      ) : null}
    </main>
  )
}

/** A single read-only goal row, harmonized with the desktop compact card. */
function GoalRow({ goal, onOpen }: { goal: Goal; onOpen: () => void }) {
  const t = useTranslations("goal")
  const style = goalStatusStyle(goal.status)
  return (
    <li>
      <Card
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            onOpen()
          }
        }}
        data-testid={`mobile-goal-${goal.id}`}
        className="relative flex cursor-pointer flex-col gap-1.5 overflow-hidden rounded-lg p-3 pl-4 shadow-none transition-colors active:bg-muted/50"
      >
        <span aria-hidden className={cn("absolute inset-y-0 left-0 w-1", style.rail)} />
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px]",
              style.chip
            )}
          >
            <span className={cn("size-1.5 rounded-full", style.dot)} aria-hidden />
            {t(`status.${goal.status}`)}
          </span>
          <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">
            {goal.turnsUsed}/{goal.config.maxTurns}
          </span>
        </div>
        <p className="line-clamp-2 text-sm font-medium">{goal.safeObjective}</p>
        <GoalRunControls goal={goal} />
      </Card>
    </li>
  )
}

GoalsMobileBody.displayName = "GoalsMobileBody"
