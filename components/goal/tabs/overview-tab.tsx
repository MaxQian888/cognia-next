"use client"

import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import type { Goal } from "@/types/goal"
import { useLiveQuery } from "dexie-react-hooks"
import { listGoalEvents } from "@/lib/db/goals"

interface Props {
  goal: Goal
}

export function GoalOverviewTab({ goal }: Props) {
  const turnPct = Math.min(100, (goal.turnsUsed / goal.config.maxTurns) * 100)
  const tokenPct = Math.min(100, (goal.tokensUsed / goal.config.maxTokens) * 100)
  const events = useLiveQuery(() => listGoalEvents(goal.id, 50), [goal.id])
  const lastJudge = events?.find((e) => e.kind === "judge_evaluated")
  const lastReason = lastJudge?.payload.kind === "judge_evaluated" ? lastJudge.payload.reason : null
  const exit = events?.find((e) => e.kind === "exit_triggered")
  const exitReason = exit?.payload.kind === "exit_triggered" ? exit.payload.reason : null

  return (
    <div className="space-y-4 text-sm">
      <div>
        <span className="text-xs text-muted-foreground">Objective</span>
        <p className="mt-1 whitespace-pre-wrap">{goal.safeObjective}</p>
      </div>
      <div className="flex flex-wrap gap-2 text-xs">
        <Badge variant="outline">Status: {goal.status}</Badge>
        <Badge variant="outline">Created: {new Date(goal.createdAt).toLocaleString()}</Badge>
        {goal.endedAt && (
          <Badge variant="outline">Ended: {new Date(goal.endedAt).toLocaleString()}</Badge>
        )}
      </div>
      <div className="space-y-1.5">
        <div className="flex justify-between text-xs">
          <span>Turns</span>
          <span>
            {goal.turnsUsed} / {goal.config.maxTurns}
          </span>
        </div>
        <Progress value={turnPct} aria-label="Turn budget used" />
      </div>
      <div className="space-y-1.5">
        <div className="flex justify-between text-xs">
          <span>Tokens</span>
          <span>
            {goal.tokensUsed.toLocaleString()} / {goal.config.maxTokens.toLocaleString()}
          </span>
        </div>
        <Progress value={tokenPct} aria-label="Token budget used" />
      </div>
      {lastReason && (
        <div>
          <span className="text-xs text-muted-foreground">Last judge reason</span>
          <p className="mt-1 italic">&ldquo;{lastReason}&rdquo;</p>
        </div>
      )}
      {exitReason && (
        <div>
          <span className="text-xs text-muted-foreground">Exit reason</span>
          <p className="mt-1">{exitReason}</p>
        </div>
      )}
    </div>
  )
}
