"use client"

/**
 * The nine-step rail (ADR-0117, Phase 3).
 *
 * Status is derived from `canAdvance` and the durable run progress rather than
 * from local component state, so a reload rebuilds the same rail from the run
 * event log. The step that blocks — and *why* it blocks — is shown inline,
 * because "the button is disabled and I don't know why" is the failure mode a
 * nine-step gated workflow produces by default.
 */

import { useTranslations } from "next-intl"
import { Check, CircleDashed, LockKeyhole, X } from "lucide-react"

import { cn } from "@/lib/utils"
import { CREATOR_STEPS, canAdvance } from "@/lib/creator/steps"
import type { CreatorAdvanceState } from "@/lib/creator/steps"
import type { CreatorStepId, CreatorStepStatus } from "@/types/creator"

export interface CreatorStepRailProps {
  state: CreatorAdvanceState
  failed?: readonly CreatorStepId[]
  /** The step currently executing, when a run is in flight. */
  activeStep?: CreatorStepId | null
  className?: string
}

export function stepStatus(
  step: CreatorStepId,
  props: Pick<CreatorStepRailProps, "state" | "failed" | "activeStep">
): CreatorStepStatus {
  if (props.failed?.includes(step)) return "failed"
  if (props.state.completed.includes(step)) return "completed"
  if (props.activeStep === step) return "active"
  const gate = canAdvance(step, props.state)
  if (!gate.allowed && gate.reason === "awaiting-approval") return "awaiting-approval"
  return "pending"
}

export function CreatorStepRail({ state, failed, activeStep, className }: CreatorStepRailProps) {
  const t = useTranslations("creator")

  return (
    <ol className={cn("space-y-1", className)}>
      {CREATOR_STEPS.map((step, index) => {
        const status = stepStatus(step.id, { state, failed, activeStep })
        const gate = canAdvance(step.id, state)
        const blockedBy =
          !gate.allowed && gate.reason === "out-of-order" ? gate.blockedBy : undefined

        return (
          <li
            key={step.id}
            className={cn(
              "flex items-start gap-3 rounded-md px-2 py-1.5 text-sm",
              status === "active" && "bg-muted/50",
              status === "pending" && "text-muted-foreground"
            )}
            aria-current={status === "active" ? "step" : undefined}
          >
            <StepIcon status={status} index={index} />
            <div className="min-w-0 flex-1">
              <p className="truncate">{t(`steps.${step.id}`)}</p>
              <p className="text-xs text-muted-foreground">
                {t(`status.${status}`)}
                {blockedBy
                  ? ` · ${t("blocked.out-of-order", { step: t(`steps.${blockedBy}`) })}`
                  : null}
              </p>
            </div>
          </li>
        )
      })}
    </ol>
  )
}

function StepIcon({ status, index }: { status: CreatorStepStatus; index: number }) {
  const className = "mt-0.5 size-4 shrink-0"
  if (status === "completed")
    return <Check className={cn(className, "text-emerald-600")} aria-hidden />
  if (status === "failed") return <X className={cn(className, "text-destructive")} aria-hidden />
  if (status === "awaiting-approval")
    return <LockKeyhole className={cn(className, "text-amber-600")} aria-hidden />
  if (status === "active")
    return <CircleDashed className={cn(className, "animate-spin")} aria-hidden />
  return (
    <span className={cn(className, "text-center text-[10px] leading-4 tabular-nums")} aria-hidden>
      {index + 1}
    </span>
  )
}

export default CreatorStepRail
