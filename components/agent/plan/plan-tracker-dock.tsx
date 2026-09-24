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
 *
 * In-session plans are driven from here too, because a paused in-session plan
 * has no driver until a chat turn is sent for it:
 *
 *   - a plan halted on a step (`stepHalt`, written by the step watchdog, a
 *     refused send, or the boot recovery) renders {@link PlanStepFailureCard}
 *     with retry / skip / mark done / cancel;
 *   - Resume re-dispatches the step the pause interrupted.
 *
 * Each of those asks the runtime for the next turn
 * (`continueInSessionPlan`) and sends it through the shared chat runtime; a
 * refused send halts the plan on that step again (`dispatch_failed`). A turn
 * still streaming on the session when the user acts on a halt is stopped
 * first — it is the stalled turn the halt is about.
 *
 * Mounting this dock also runs the once-per-load recovery of in-session steps
 * orphaned by an app restart (`ensurePlanStepRecovery`): every chat view
 * mounts it, and only a chat view can drive an in-session plan.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { PlanTrackerPanel } from "./plan-tracker-panel"
import { PlanStepFailureCard } from "./plan-step-failure-card"
import { useSessionPlan } from "@/hooks/agent/use-session-plan"
import { useOptionalClaudeChat } from "@/hooks/chat/use-claude-chat"
import { getPlanRuntime, type PlanContinueOutcome } from "@/lib/agent/plan/runtime"
import { ensurePlanStepRecovery } from "@/lib/agent/plan/step-recovery"
import { resolvePlanStrategy } from "@/lib/agent/plan/strategy"
import { chatPlanStepHooks } from "@/lib/agent/plan/turn-driver"
import { useChatStore } from "@/stores/chat"
import type { PlanStepContinueAction } from "@/types/agent/plan"

export interface PlanTrackerDockProps {
  sessionId: string
}

export function PlanTrackerDock({ sessionId }: PlanTrackerDockProps) {
  const t = useTranslations("plan")
  const plan = useSessionPlan(sessionId)
  const chat = useOptionalClaudeChat()
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void ensurePlanStepRecovery()
  }, [])

  if (!plan || (plan.status !== "executing" && plan.status !== "paused")) return null

  const inSession = resolvePlanStrategy(plan) === "in_session"
  const halt = plan.status === "paused" && inSession ? plan.stepHalt : undefined

  const run = async (action: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true)
    try {
      await action()
    } catch {
      toast.error(t("stepFailure.actionFailed"))
    } finally {
      setBusy(false)
    }
  }

  /** Stop a turn still holding the session — the stalled turn a halt is about. */
  const stopStalledTurn = async () => {
    const status = useChatStore.getState().sessions[sessionId]?.status
    if (chat && (status === "streaming" || status === "awaiting_approval")) {
      await chat.stop(sessionId)
    }
  }

  /** Send the turn the runtime prepared; a refused send halts the step again. */
  const dispatch = async (outcome: PlanContinueOutcome) => {
    if (outcome.kind !== "continue" || !chat) return
    try {
      await chat.send(outcome.userMessage, undefined, {
        sessionId,
        skipUserAppend: true,
        throwOnError: true,
      })
    } catch (error) {
      await getPlanRuntime().failInSessionStep(plan.id, {
        stepId: outcome.stepId,
        cause: "dispatch_failed",
        detail: error instanceof Error ? error.message : String(error),
        capturedGenerationId: outcome.generationId,
      })
    }
  }

  const continueWith = (action: PlanStepContinueAction) =>
    run(async () => {
      if (halt) await stopStalledTurn()
      const outcome = await getPlanRuntime().continueInSessionPlan(plan.id, action, {
        hooks: chatPlanStepHooks(plan.id, sessionId),
      })
      await dispatch(outcome)
    })

  const cancel = () =>
    run(async () => {
      if (halt) await stopStalledTurn()
      await getPlanRuntime().cancelPlan(plan.id)
    })

  return (
    <div
      className="max-h-[35vh] space-y-2 overflow-y-auto overscroll-contain pb-2"
      data-testid="plan-tracker-dock"
    >
      {halt && (
        <PlanStepFailureCard
          plan={plan}
          halt={halt}
          busy={busy}
          canDispatch={Boolean(chat)}
          onRetry={() => void continueWith("retry")}
          onSkip={() => void continueWith("skip")}
          onMarkDone={() => void continueWith("complete")}
          onResume={() => void continueWith("resume")}
          onCancel={() => void cancel()}
        />
      )}
      <PlanTrackerPanel plan={plan} />
      {!halt && (
        <div className="flex items-center justify-end gap-2">
          {plan.status === "executing" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void run(() => getPlanRuntime().pausePlan(plan.id))}
              data-testid="plan-tracker-pause"
            >
              {t("tracker.pause")}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              // An in-session plan needs a chat surface to send the resumed turn.
              disabled={busy || (inSession && !chat)}
              onClick={() =>
                void (inSession
                  ? continueWith("resume")
                  : run(() => getPlanRuntime().resumePlan(plan.id)))
              }
              data-testid="plan-tracker-resume"
            >
              {t("tracker.resume")}
            </Button>
          )}
          <Button
            size="sm"
            variant="destructive"
            disabled={busy}
            onClick={() => void cancel()}
            data-testid="plan-tracker-cancel"
          >
            {t("tracker.cancel")}
          </Button>
        </div>
      )}
    </div>
  )
}
