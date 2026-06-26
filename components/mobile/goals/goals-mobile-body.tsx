"use client"

/**
 * Mobile companion Goals view (closes the `/goals` desktop-only gap).
 *
 * Read-mostly mirror of the desktop GoalConsole: lists the workspace's goals
 * from Dexie (warmed by the `goals` sync handler so it works offline), shows a
 * status stat strip, and opens the shared `GoalDetailSheet` on tap. Goal
 * authoring / templates / tracker config stay on the desktop.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { TargetIcon } from "lucide-react"

import { Card } from "@/components/ui/card"
import { EmptyState } from "@/components/mobile/empty-state"
import { PullToRefresh } from "@/components/interactions/pull-to-refresh"
import { GoalDetailSheet } from "@/components/goal/goal-detail-sheet"
import { goalStatusStyle } from "@/components/goal/goal-status-style"
import { listAllGoals } from "@/lib/db/goals"
import { runSyncDown } from "@/lib/sync/companion-sync"
import { isTerminalGoalStatus } from "@/types/goal"
import type { Goal } from "@/types/goal"
import { cn } from "@/lib/utils"

export function GoalsMobileBody() {
  const t = useTranslations("mobile.goals")
  const tGoal = useTranslations("goal")
  const goals = useLiveQuery(() => listAllGoals(), [])
  const [selected, setSelected] = useState<Goal | null>(null)

  const stats = useMemo(() => {
    const list = goals ?? []
    return {
      active: list.filter((g) => g.status === "active").length,
      paused: list.filter((g) => g.status === "paused").length,
      done: list.filter((g) => isTerminalGoalStatus(g.status)).length,
    }
  }, [goals])
  const list = goals ?? []

  const handleRefresh = async (): Promise<void> => {
    try {
      await runSyncDown({ only: ["goals"] })
    } catch {
      // Orchestrator swallows handler-level failures.
    }
  }

  return (
    <main
      className="flex min-h-[100dvh] flex-col gap-4 bg-background pt-3 safe-area-pt"
      data-testid="mobile-goals-body"
    >
      <header className="px-4">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
      </header>

      <div className="grid grid-cols-3 gap-2 px-4" data-testid="mobile-goals-stats">
        <StatTile label={t("stats.active")} value={stats.active} />
        <StatTile label={t("stats.paused")} value={stats.paused} />
        <StatTile label={t("stats.done")} value={stats.done} />
      </div>

      <PullToRefresh onRefresh={handleRefresh}>
        <section className="flex flex-col gap-2 px-4 pb-4">
          {list.length === 0 ? (
            <EmptyState icon={TargetIcon} title={t("empty")} />
          ) : (
            <ul className="flex flex-col gap-2">
              {list.map((goal) => {
                const style = goalStatusStyle(goal.status)
                return (
                  <li key={goal.id}>
                    <Card
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelected(goal)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault()
                          setSelected(goal)
                        }
                      }}
                      data-testid={`mobile-goal-${goal.id}`}
                      className="flex cursor-pointer flex-col gap-1.5 rounded-md p-3 shadow-none transition-colors active:bg-muted/50"
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px]",
                            style.chip
                          )}
                        >
                          <span className={cn("size-1.5 rounded-full", style.dot)} aria-hidden />
                          {tGoal(`status.${goal.status}`)}
                        </span>
                        <span className="ml-auto text-[10px] text-muted-foreground">
                          {t("progress", {
                            turns: goal.turnsUsed,
                            maxTurns: goal.config.maxTurns,
                          })}
                        </span>
                      </div>
                      <p className="line-clamp-2 text-sm font-medium">{goal.safeObjective}</p>
                    </Card>
                  </li>
                )
              })}
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

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border bg-card p-3 text-center">
      <div className="text-xl font-semibold">{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
    </div>
  )
}
