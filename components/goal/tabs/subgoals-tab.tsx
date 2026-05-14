"use client"

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
  return (
    <div
      className="rounded-md border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground"
      data-testid="goal-subgoals-placeholder"
    >
      <p className="font-medium">Subgoals — Phase 2</p>
      <p className="mt-2">
        Automatic subgoal decomposition (Hermes-style breakdown into bullet steps) is deferred to a
        later release. For now the model decides its own next step each turn against the parent
        objective:
      </p>
      <blockquote className="mt-3 border-l-2 pl-3 italic">{goal.safeObjective}</blockquote>
    </div>
  )
}
