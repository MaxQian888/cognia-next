"use client"

import { useTranslations } from "next-intl"
import type { Goal } from "@/types/goal"

interface Props {
  goal: Goal
}

/**
 * Placeholder for Phase 2 subgoal decomposition. Phase 1 ships without
 * automated subgoal splitting — the model is responsible for sequencing
 * its own next steps inside the continuation loop.
 */
export function GoalSubgoalsTab({ goal }: Props) {
  const t = useTranslations("goal")
  return (
    <div
      className="rounded-md border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground"
      data-testid="goal-subgoals-placeholder"
    >
      <p className="font-medium">{t("subgoals.title")}</p>
      <p className="mt-2">{t("subgoals.body")}</p>
      <blockquote className="mt-3 border-l-2 pl-3 italic">{goal.safeObjective}</blockquote>
    </div>
  )
}
