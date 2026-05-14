"use client"

/**
 * Compact pill that surfaces the active `/goal` (ADR-0013) just above the
 * chat composer. Renders nothing when no active goal exists, so the
 * composer area only changes when the user actually opted in.
 *
 * Controls:
 *  - 🎯 + objective summary (truncated)
 *  - turn / token progress text
 *  - ⏸ pause / ▶ resume button
 *  - ⏹ stop button
 *  - 🔍 open detail sheet
 *
 * No keyboard shortcut wiring here — the user already has `/goal pause`
 * / `/goal stop` slash commands. The pill is an at-a-glance affordance,
 * not the primary control surface.
 */

import { useState } from "react"
import { PauseIcon, PlayIcon, SquareIcon, SearchIcon, TargetIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { getGoalRuntime } from "@/lib/goal/runtime"
import type { Goal } from "@/types/goal"
import { useOpenGoal } from "./use-active-goal"
import { GoalDetailSheet } from "./goal-detail-sheet"

interface Props {
  sessionId: string | null
  /** Override hook output — used by tests and Storybook. */
  goalOverride?: Goal | null
  className?: string
}

export function GoalStatusPill({ sessionId, goalOverride, className }: Props) {
  const liveGoal = useOpenGoal(sessionId)
  const goal = goalOverride !== undefined ? goalOverride : (liveGoal ?? null)
  const [open, setOpen] = useState(false)

  if (!goal) return null

  const isActive = goal.status === "active"
  const isPaused = goal.status === "paused"
  const progressLabel = `${goal.turnsUsed}/${goal.config.maxTurns} turns · ${(goal.tokensUsed / 1000).toFixed(1)}k tok`

  return (
    <>
      <div
        data-testid="goal-status-pill"
        role="status"
        aria-label={`Active goal: ${goal.safeObjective}`}
        className={cn(
          "flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-1.5 text-xs",
          className
        )}
      >
        <TargetIcon className="size-4 shrink-0 text-primary" aria-hidden />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium" title={goal.safeObjective}>
              {goal.safeObjective}
            </span>
            <span className="shrink-0 rounded-sm bg-background px-1 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              {goal.status}
            </span>
          </div>
          <span className="text-[10px] text-muted-foreground">{progressLabel}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {isActive && (
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              aria-label="Pause goal"
              data-testid="goal-pause-button"
              onClick={() => {
                void getGoalRuntime().pauseGoal(goal.id)
              }}
            >
              <PauseIcon className="size-3.5" aria-hidden />
            </Button>
          )}
          {isPaused && (
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              aria-label="Resume goal"
              data-testid="goal-resume-button"
              onClick={() => {
                void getGoalRuntime().resumeGoal(goal.id)
              }}
            >
              <PlayIcon className="size-3.5" aria-hidden />
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label="Stop goal"
            data-testid="goal-stop-button"
            onClick={() => {
              void getGoalRuntime().stopGoal(goal.id)
            }}
          >
            <SquareIcon className="size-3.5" aria-hidden />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label="Open goal details"
            data-testid="goal-show-button"
            onClick={() => setOpen(true)}
          >
            <SearchIcon className="size-3.5" aria-hidden />
          </Button>
        </div>
      </div>
      <GoalDetailSheet goal={goal} open={open} onOpenChange={setOpen} />
    </>
  )
}

GoalStatusPill.displayName = "GoalStatusPill"
