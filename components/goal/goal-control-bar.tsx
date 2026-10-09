"use client"

/**
 * The run controls for one open goal — continue one turn, pause or resume, and
 * stop — as every goal surface draws them (ADR-0019).
 *
 * `variant="icon"` is the dense form a list row or grid tile carries: ghost
 * icon buttons, each with a tooltip (the old card relied on `aria-label`
 * alone, so a sighted user had to guess what a square meant).
 * `variant="labelled"` is the inspector's: outline buttons that say what they
 * do, sized for touch below `md`.
 *
 * Transport (local runtime vs the companion RPC) and failure reporting live in
 * `useGoalControls`; stop always confirms first (`GoalStopConfirm`). A goal
 * waiting on the acceptance gate has no Resume here: the verdict (Accept /
 * Request changes) is what moves it, and that has its own buttons.
 *
 * Clicks stop propagating, because the row or tile around the bar is itself a
 * button that selects the goal.
 */

import { useState, type MouseEvent, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { PauseIcon, PlayIcon, SquareIcon, StepForwardIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useGoalControls } from "@/hooks/goal/use-goal-controls"
import { isAwaitingAcceptance, isOpenGoal } from "@/lib/goal/overview-filter"
import { cn } from "@/lib/utils"
import type { Goal } from "@/types/goal"

import { GoalStopConfirm } from "./goal-stop-confirm"

export interface GoalControlBarProps {
  goal: Goal
  variant?: "icon" | "labelled"
  className?: string
}

export function GoalControlBar({ goal, variant = "icon", className }: GoalControlBarProps) {
  const t = useTranslations("goal")
  const controls = useGoalControls(goal)
  const [confirmStop, setConfirmStop] = useState(false)

  if (!isOpenGoal(goal) || !controls.allowed) return null

  const awaiting = isAwaitingAcceptance(goal)
  const isActive = goal.status === "active"

  const guard = (handler: () => void) => (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    handler()
  }

  return (
    <div
      className={cn(
        "flex items-center",
        variant === "icon" ? "gap-0.5" : "flex-wrap gap-2",
        className
      )}
      data-testid={`goal-control-bar-${goal.id}`}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      role="group"
      aria-label={t("controls.groupAria")}
    >
      {controls.canContinue ? (
        <ControlButton
          variant={variant}
          label={t("pill.continue")}
          icon={<StepForwardIcon />}
          disabled={controls.busy}
          onClick={guard(() => void controls.continueTurn())}
          testId="goal-control-continue"
        />
      ) : null}
      {isActive ? (
        <ControlButton
          variant={variant}
          label={t("pill.pause")}
          icon={<PauseIcon />}
          disabled={controls.busy}
          onClick={guard(() => void controls.pause())}
          testId="goal-control-pause"
        />
      ) : null}
      {goal.status === "paused" && !awaiting ? (
        <ControlButton
          variant={variant}
          label={t("pill.resume")}
          icon={<PlayIcon />}
          disabled={controls.busy}
          onClick={guard(() => void controls.resume())}
          testId="goal-control-resume"
        />
      ) : null}
      <ControlButton
        variant={variant}
        label={t("pill.stop")}
        icon={<SquareIcon />}
        destructive
        disabled={controls.busy}
        onClick={guard(() => setConfirmStop(true))}
        testId="goal-control-stop"
      />
      <GoalStopConfirm
        open={confirmStop}
        onOpenChange={setConfirmStop}
        objective={goal.safeObjective}
        onConfirm={() => {
          setConfirmStop(false)
          void controls.stop()
        }}
      />
    </div>
  )
}

function ControlButton({
  variant,
  label,
  icon,
  destructive = false,
  disabled,
  onClick,
  testId,
}: {
  variant: "icon" | "labelled"
  label: string
  icon: ReactNode
  destructive?: boolean
  disabled?: boolean
  onClick: (event: MouseEvent) => void
  testId: string
}) {
  if (variant === "labelled") {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={onClick}
        className={cn(
          "min-h-11 md:min-h-8 [&_svg]:size-3.5",
          destructive && "text-destructive hover:text-destructive"
        )}
        data-testid={testId}
      >
        {icon}
        {label}
      </Button>
    )
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          disabled={disabled}
          onClick={onClick}
          aria-label={label}
          className={cn(
            "size-8 text-muted-foreground hover:text-foreground [&_svg]:size-4",
            destructive && "hover:text-destructive"
          )}
          data-testid={testId}
        >
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

GoalControlBar.displayName = "GoalControlBar"
