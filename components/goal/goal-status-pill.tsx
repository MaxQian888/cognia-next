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
import { useTranslations } from "next-intl"
import {
  PauseIcon,
  PlayIcon,
  SquareIcon,
  SearchIcon,
  StepForwardIcon,
  TargetIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { getGoalRuntime } from "@/lib/goal/runtime"
import type { Goal } from "@/types/goal"
import { useOpenGoal } from "./use-active-goal"
import { goalStatusStyle } from "./goal-status-style"
import { GoalDetailSheet } from "./goal-detail-sheet"

interface Props {
  sessionId: string | null
  /** Override hook output — used by tests and Storybook. */
  goalOverride?: Goal | null
  className?: string
}

export function GoalStatusPill({ sessionId, goalOverride, className }: Props) {
  const t = useTranslations("goal")
  const liveGoal = useOpenGoal(sessionId)
  const goal = goalOverride !== undefined ? goalOverride : (liveGoal ?? null)
  const [open, setOpen] = useState(false)

  if (!goal) return null

  const isActive = goal.status === "active"
  const isPaused = goal.status === "paused"
  const style = goalStatusStyle(goal.status)
  const progressLabel = t("pill.progress", {
    turns: goal.turnsUsed,
    maxTurns: goal.config.maxTurns,
    tokens: (goal.tokensUsed / 1000).toFixed(1),
  })

  return (
    <>
      <div
        data-testid="goal-status-pill"
        role="status"
        aria-label={t("pill.ariaActiveGoal", { objective: goal.safeObjective })}
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
            <span
              className={cn(
                "inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
                style.chip
              )}
            >
              <span className="relative flex size-1.5">
                {style.pulse && (
                  <span
                    className={cn(
                      "absolute inline-flex size-full animate-ping rounded-full opacity-60",
                      style.dot
                    )}
                  />
                )}
                <span className={cn("relative inline-flex size-1.5 rounded-full", style.dot)} />
              </span>
              {t(`status.${goal.status}`)}
            </span>
          </div>
          <span className="text-[10px] text-muted-foreground">{progressLabel}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {isActive && goal.config.manualContinue && (
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              aria-label={t("pill.continue")}
              data-testid="goal-continue-button"
              onClick={() => {
                getGoalRuntime().requestManualContinue(goal.id)
              }}
            >
              <StepForwardIcon className="size-3.5" aria-hidden />
            </Button>
          )}
          {isActive && (
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              aria-label={t("pill.pause")}
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
              aria-label={t("pill.resume")}
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
            aria-label={t("pill.stop")}
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
            aria-label={t("pill.details")}
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
