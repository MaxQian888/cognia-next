"use client"

/**
 * Live tracker dock for an EXECUTING / PAUSED plan — mounts the (previously
 * dormant) {@link PlanTrackerPanel} above the composer, in the same chat-view
 * slot as the approval dock (their gating statuses are mutually exclusive).
 * Adds pause / resume / cancel controls wired to the plan runtime.
 *
 * Both executors reach `executing` and therefore this dock: orchestrated runs
 * (`runPlan` → workflow driver) and in-session runs (`startPlan` → the chat
 * hook's turn driver, one visible turn per step). Pausing an in-session plan
 * rotates its generation, which makes the next `handlePlanTurnComplete` return
 * `stale` — that is how the driver stops.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { PlanTrackerPanel } from "./plan-tracker-panel"
import { useSessionPlan } from "@/hooks/agent/use-session-plan"
import { getPlanRuntime } from "@/lib/agent/plan/runtime"

export interface PlanTrackerDockProps {
  sessionId: string
}

export function PlanTrackerDock({ sessionId }: PlanTrackerDockProps) {
  const t = useTranslations("plan")
  const plan = useSessionPlan(sessionId)
  const [busy, setBusy] = useState(false)

  if (!plan || (plan.status !== "executing" && plan.status !== "paused")) return null

  const run = async (action: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true)
    try {
      await action()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="max-h-[35vh] overflow-y-auto overscroll-contain px-3 pb-2"
      data-testid="plan-tracker-dock"
    >
      <PlanTrackerPanel plan={plan} />
      <div className="flex items-center justify-end gap-2 pt-2">
        {plan.status === "executing" ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => run(() => getPlanRuntime().pausePlan(plan.id))}
            data-testid="plan-tracker-pause"
          >
            {t("tracker.pause")}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => run(() => getPlanRuntime().resumePlan(plan.id))}
            data-testid="plan-tracker-resume"
          >
            {t("tracker.resume")}
          </Button>
        )}
        <Button
          size="sm"
          variant="destructive"
          disabled={busy}
          onClick={() => run(() => getPlanRuntime().cancelPlan(plan.id))}
          data-testid="plan-tracker-cancel"
        >
          {t("tracker.cancel")}
        </Button>
      </div>
    </div>
  )
}
