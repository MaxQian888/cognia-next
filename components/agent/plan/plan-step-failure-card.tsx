"use client"

/**
 * In-card error for an in-session plan halted on a step (ADR-0045 §2).
 *
 * Rendered by {@link PlanTrackerDock} above the live step list when
 * `PlanRuntime.failInSessionStep` paused the plan: the step's turn failed,
 * was never sent, went silent, ended unrecorded, or died with the app. It
 * says which step, why (localized from `stepHalt.cause`, with the raw detail
 * as supporting text), and offers the decisions the plan model supports:
 *
 *   Retry step → run the same step again (attempt N+1)
 *   Skip step  → carry on without it (its dependents are re-pointed)
 *   Mark done  → the user did / verified the work; record it and move on
 *   Cancel     → abandon the plan
 *
 * A halt with no step (the app restarted between steps) offers Resume instead
 * of the step actions. Controlled: the host performs every action; the card
 * only knows whether a chat surface is there to send the next turn.
 */

import { useTranslations } from "next-intl"
import { AlertTriangleIcon } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { haltedStep, stepDisplayIndex } from "@/lib/agent/plan/step-halt"
import {
  PLAN_STEP_SILENCE_TIMEOUT_MS,
  PLAN_STEP_START_TIMEOUT_MS,
} from "@/lib/agent/plan/step-watchdog"
import type { AgentPlan, PlanStepHalt } from "@/types/agent/plan"

export interface PlanStepFailureCardProps {
  plan: AgentPlan
  halt: PlanStepHalt
  /** An action is in flight — every button is disabled. */
  busy?: boolean
  /**
   * Whether a chat surface can send the next turn. Without one, only Cancel
   * is actionable (retry / skip / done / resume all start a turn).
   */
  canDispatch: boolean
  onRetry: () => void
  onSkip: () => void
  onMarkDone: () => void
  onResume: () => void
  onCancel: () => void
}

export function PlanStepFailureCard({
  plan,
  halt,
  busy,
  canDispatch,
  onRetry,
  onSkip,
  onMarkDone,
  onResume,
  onCancel,
}: PlanStepFailureCardProps) {
  const t = useTranslations("plan.stepFailure")
  const step = haltedStep({ steps: plan.steps, stepHalt: halt })
  const index = step ? stepDisplayIndex(plan, step.id) : 0
  const attempts = step?.attempts ?? 0
  const dispatchDisabled = busy || !canDispatch

  return (
    <Alert variant="destructive" data-testid="plan-step-failure" data-cause={halt.cause}>
      <AlertTriangleIcon />
      <AlertTitle className="break-words">
        {step ? t(`title.${halt.cause}`, { index, title: step.title }) : t("betweenSteps")}
      </AlertTitle>
      <AlertDescription className="space-y-2">
        <p>
          {t(`hint.${halt.cause}`, {
            seconds: Math.round(PLAN_STEP_START_TIMEOUT_MS / 1000),
            minutes: Math.round(PLAN_STEP_SILENCE_TIMEOUT_MS / 60_000),
          })}
        </p>
        {halt.detail && (
          <p className="break-words font-mono text-[11px]" data-testid="plan-step-failure-detail">
            <span className="sr-only">{t("detailLabel")}: </span>
            {halt.detail}
          </p>
        )}
        {attempts > 1 && (
          <p className="text-[11px]" data-testid="plan-step-failure-attempt">
            {t("attempt", { count: attempts })}
          </p>
        )}
        {!canDispatch && (
          <p className="text-[11px]" data-testid="plan-step-failure-no-chat">
            {t("noChat")}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
          {step ? (
            <>
              <Button
                size="sm"
                disabled={dispatchDisabled}
                onClick={onRetry}
                data-testid="plan-step-retry"
              >
                {t("retry")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={dispatchDisabled}
                onClick={onSkip}
                data-testid="plan-step-skip"
              >
                {t("skip")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={dispatchDisabled}
                onClick={onMarkDone}
                data-testid="plan-step-mark-done"
              >
                {t("markDone")}
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              disabled={dispatchDisabled}
              onClick={onResume}
              data-testid="plan-step-resume"
            >
              {t("resume")}
            </Button>
          )}
          <Button
            size="sm"
            variant="destructive"
            disabled={busy}
            onClick={onCancel}
            data-testid="plan-step-cancel"
          >
            {t("cancel")}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  )
}
