"use client"

/**
 * Remote pause / resume / stop controls for a goal row on the mobile Goals
 * surface. The goal loop runs on the paired desktop, so unlike the desktop
 * `active-goal-card` (which drives `getGoalRuntime()` in-process) these
 * round-trip through the Companion `goal_pause` / `goal_resume` / `goal_stop`
 * RPCs — the same remote-session-control plane the agent-team board uses.
 *
 * Renders nothing unless this device holds the remote-control capability
 * (`useCanControl`), mirroring `mobile-consent-sheet`, so observe-only
 * phones never see buttons that would 403.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { PauseIcon, PlayIcon, SquareIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useCanControl } from "@/hooks/data/use-can-control"
import { transport } from "@/lib/tauri/transport-instance"
import type { Goal } from "@/types/goal"

export interface GoalRunControlsProps {
  goal: Goal
}

export function GoalRunControls({ goal }: GoalRunControlsProps) {
  const t = useTranslations("goal")
  const canControl = useCanControl()
  const [busy, setBusy] = useState(false)

  const isActive = goal.status === "active"
  const isPaused = goal.status === "paused"
  if (canControl !== true || (!isActive && !isPaused)) return null

  const call = async (command: "goal_pause" | "goal_resume" | "goal_stop") => {
    setBusy(true)
    try {
      await transport.call(command, { goalId: goal.id })
      // The status flip lands via the normal `goals` sync-down; the toast
      // just confirms the desktop accepted the transition.
      toast.success(t("remote.applied"))
    } catch {
      toast.error(t("remote.failed"))
    } finally {
      setBusy(false)
    }
  }

  // Buttons stop propagation — they sit inside the tap-to-open goal card.
  const guard = (e: React.MouseEvent, command: Parameters<typeof call>[0]) => {
    e.preventDefault()
    e.stopPropagation()
    void call(command)
  }

  return (
    <div className="flex items-center gap-1.5" data-testid={`goal-run-controls-${goal.id}`}>
      {isActive ? (
        <Button
          size="sm"
          variant="outline"
          className="h-8 px-2.5 text-xs"
          disabled={busy}
          onClick={(e) => guard(e, "goal_pause")}
          data-testid="mobile-goal-pause"
        >
          <PauseIcon className="size-3.5" aria-hidden="true" />
          {t("pill.pause")}
        </Button>
      ) : (
        <Button
          size="sm"
          variant="outline"
          className="h-8 px-2.5 text-xs"
          disabled={busy}
          onClick={(e) => guard(e, "goal_resume")}
          data-testid="mobile-goal-resume"
        >
          <PlayIcon className="size-3.5" aria-hidden="true" />
          {t("pill.resume")}
        </Button>
      )}
      <Button
        size="sm"
        variant="outline"
        className="h-8 px-2.5 text-xs text-destructive"
        disabled={busy}
        onClick={(e) => guard(e, "goal_stop")}
        data-testid="mobile-goal-stop"
      >
        <SquareIcon className="size-3.5" aria-hidden="true" />
        {t("pill.stop")}
      </Button>
    </div>
  )
}
