"use client"

/**
 * Accept / Request changes for a goal parked by the acceptance gate
 * (ADR-0019, `GoalConfig.requireAcceptance`).
 *
 * The verdict used to be reachable only from a banner inside the detail sheet,
 * so a goal waiting on the user looked like any other paused goal until
 * someone opened it. The console's "Needs you" list and the inspector both draw
 * these buttons now. A failure says so instead of re-enabling silently.
 *
 * The verdict goes through `useGoalControls().accept`, so on a paired phone it
 * reaches the desktop over `goal_accept` (it used to write the phone's own
 * database, where no loop was waiting on it), and the buttons only show for a
 * device holding the remote-control grant.
 */

import type { MouseEvent } from "react"
import { useTranslations } from "next-intl"
import { CheckIcon, Undo2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useGoalControls } from "@/hooks/goal/use-goal-controls"
import { cn } from "@/lib/utils"
import type { Goal } from "@/types/goal"

export interface GoalAcceptanceActionsProps {
  goal: Pick<Goal, "id" | "status" | "config">
  /** `compact` for a list row; the default is sized for the inspector banner. */
  size?: "compact" | "default"
  className?: string
}

export function GoalAcceptanceActions({
  goal,
  size = "default",
  className,
}: GoalAcceptanceActionsProps) {
  const t = useTranslations("goal.acceptance")
  const controls = useGoalControls(goal)
  const busy = controls.busy

  // The hook confirms or reports the verdict; nothing left to do here.
  const resolve = (accepted: boolean) => (event: MouseEvent) => {
    event.stopPropagation()
    if (busy) return
    void controls.accept(accepted)
  }

  // An observe-only paired phone cannot record a verdict on the desktop.
  if (!controls.allowed) return null

  // A list row sits at 44px with two lines of text; full-height buttons
  // there would set the row's height instead of the content.
  const buttonSize = size === "compact" ? "xs" : "sm"
  return (
    <div
      className={cn("flex flex-wrap items-center gap-2", className)}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <Button
        type="button"
        size={buttonSize}
        disabled={busy}
        onClick={resolve(true)}
        className={cn(size === "default" && "min-h-11 md:min-h-8")}
        data-testid="goal-acceptance-accept"
      >
        <CheckIcon className="size-3.5" aria-hidden />
        {t("accept")}
      </Button>
      <Button
        type="button"
        size={buttonSize}
        variant="outline"
        disabled={busy}
        onClick={resolve(false)}
        className={cn(size === "default" && "min-h-11 md:min-h-8")}
        data-testid="goal-acceptance-request-changes"
      >
        <Undo2Icon className="size-3.5" aria-hidden />
        {t("requestChanges")}
      </Button>
    </div>
  )
}

GoalAcceptanceActions.displayName = "GoalAcceptanceActions"
