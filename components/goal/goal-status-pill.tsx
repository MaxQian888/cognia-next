"use client"

/**
 * Compact pill that surfaces the active `/goal` (ADR-0013) just above the
 * chat composer. Renders nothing when no active goal exists, so the
 * composer area only changes when the user actually opted in.
 *
 * Composes the shared `ActivityPill` primitive (also used by the /loop
 * status pill) — the primitive owns layout, truncation, the status chip,
 * and the mobile action collapse (≥44px touch targets, secondary actions
 * behind a dropdown). This file only maps goal domain state onto it.
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
import { ActivityPill, type ActivityPillAction } from "@/components/shared/activity-pill"
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

  // "Next continuation at HH:mm (reason)" — stamped by the pacing gate on a
  // defer (adaptive pacing) and cleared on dispatch, so rendering whenever
  // it's present on an active goal stays honest without clock reads here.
  const footnote =
    isActive && goal.nextContinuationAt
      ? t("pill.nextContinuation", {
          time: new Intl.DateTimeFormat(undefined, {
            hour: "2-digit",
            minute: "2-digit",
          }).format(goal.nextContinuationAt),
          reason: t(`pill.pacingReason.${goal.nextContinuationSource ?? "interval"}`),
        })
      : undefined

  const actions: ActivityPillAction[] = []
  if (isActive && goal.config.manualContinue) {
    actions.push({
      id: "continue",
      icon: <StepForwardIcon />,
      label: t("pill.continue"),
      onClick: () => {
        getGoalRuntime().requestManualContinue(goal.id)
      },
      testId: "goal-continue-button",
      primary: true,
    })
  }
  if (isActive) {
    actions.push({
      id: "pause",
      icon: <PauseIcon />,
      label: t("pill.pause"),
      onClick: () => {
        void getGoalRuntime().pauseGoal(goal.id)
      },
      testId: "goal-pause-button",
      primary: true,
    })
  }
  if (isPaused) {
    actions.push({
      id: "resume",
      icon: <PlayIcon />,
      label: t("pill.resume"),
      onClick: () => {
        void getGoalRuntime().resumeGoal(goal.id)
      },
      testId: "goal-resume-button",
      primary: true,
    })
  }
  actions.push({
    id: "stop",
    icon: <SquareIcon />,
    label: t("pill.stop"),
    onClick: () => {
      void getGoalRuntime().stopGoal(goal.id)
    },
    testId: "goal-stop-button",
  })
  actions.push({
    id: "details",
    icon: <SearchIcon />,
    label: t("pill.details"),
    onClick: () => setOpen(true),
    testId: "goal-show-button",
  })

  return (
    <>
      <ActivityPill
        icon={<TargetIcon className="size-4" aria-hidden />}
        title={goal.safeObjective}
        titleTooltip={goal.safeObjective}
        chip={{
          label: t(`status.${goal.status}`),
          chipClassName: style.chip,
          dotClassName: style.dot,
          pulse: style.pulse,
        }}
        subtext={progressLabel}
        footnote={footnote}
        actions={actions}
        ariaLabel={t("pill.ariaActiveGoal", { objective: goal.safeObjective })}
        moreLabel={t("pill.moreActions")}
        className={className}
        data-testid="goal-status-pill"
      />
      <GoalDetailSheet goal={goal} open={open} onOpenChange={setOpen} />
    </>
  )
}

GoalStatusPill.displayName = "GoalStatusPill"
