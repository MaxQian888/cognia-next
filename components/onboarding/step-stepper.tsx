"use client"

import { useTranslations } from "next-intl"
import type { OnboardingStepId } from "@cognia/agent-config-types"

import { GuideStepper } from "@/components/guide/guide-stepper"
import type { OnboardingStepDef } from "@/lib/onboarding/steps"

interface StepStepperProps {
  sequence: readonly OnboardingStepDef[]
  current: OnboardingStepId
  /** Jump back to an already-completed step. Omit to make the row read-only. */
  onStepChange?: (step: OnboardingStepId) => void
  /** Steps raise this while a request is in flight, locking the row. */
  busy?: boolean
  className?: string
}

/**
 * The first-run flow's progress row — the shared `GuideStepper` fed from the
 * resolved step sequence (ADR-0193).
 *
 * **Only progress-bearing steps are numbered.** Reading the intro is not
 * setup, and counting it makes the flow feel longer than it is.
 *
 * **Recommended mode does not render this at all.** Its sequence is two
 * screens, one of which is the intro — a row reading "1 of 1" tells the user
 * nothing except that they took the short path. Its progress is the plan
 * lines completing.
 *
 * The `onboarding-rail-*` test ids are the hooks the previous rail exposed;
 * the e2e specs still hang off them.
 */
export function StepStepper({
  sequence,
  current,
  onStepChange,
  busy = false,
  className,
}: StepStepperProps) {
  const t = useTranslations("onboarding")
  const counted = sequence.filter((s) => s.countsAsProgress)

  if (counted.length === 0) return null

  return (
    <GuideStepper
      items={counted.map((step) => ({ id: step.id, label: t(`rail.${step.id}.label`) }))}
      current={current}
      onSelect={onStepChange ? (id) => onStepChange(id as OnboardingStepId) : undefined}
      busy={busy}
      ariaLabel={t("rail.label")}
      testId="onboarding-stepper"
      itemTestIdPrefix="onboarding-rail"
      className={className}
    />
  )
}
