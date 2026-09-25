"use client"

import type { ReactNode } from "react"
import { useTranslations } from "next-intl"
import type { OnboardingStepId } from "@cognia/agent-config-types"

import { GuideNarrativePanel } from "@/components/guide/guide-narrative-panel"
import { StepStepper } from "./step-stepper"
import type { OnboardingStepDef } from "@/lib/onboarding/steps"

interface NarrativePanelProps {
  /** Which scene to show. Supplied by the flow, drawn by the caller. */
  scene: ReactNode
  /** Keys the crossfade between scenes. */
  sceneKey: string
  /**
   * Which entry under `onboarding.narrative.*` to read. Defaults to the step
   * id, and is overridden where one step has more than one thing to say — the
   * recommended screen promises "nothing runs until you say so" while it is
   * showing the plan, which becomes a lie the moment it starts running it.
   */
  narrativeKey?: string
  sequence: readonly OnboardingStepDef[]
  current: OnboardingStepId
  onStepChange?: (step: OnboardingStepId) => void
  busy?: boolean
  /** Hidden in recommended mode — see {@link StepStepper}. */
  showStepper?: boolean
}

/**
 * The left half of the first-run takeover (ADR-0141): the shared guide panel
 * with the step's scene, its line of narration, and — on the step-by-step
 * path — the progress row.
 *
 * The panel takes real width and earns it: the scene inside it is drawn from
 * live data, so the scan step's picture differs per machine and the
 * recommended step's picture changes as the plan runs. Geometry, substrate and
 * motion live in `GuideNarrativePanel` so `/pair` draws the same panel.
 */
export function NarrativePanel({
  scene,
  sceneKey,
  narrativeKey,
  sequence,
  current,
  onStepChange,
  busy = false,
  showStepper = true,
}: NarrativePanelProps) {
  const t = useTranslations("onboarding")
  const copyKey = narrativeKey ?? current
  // Before the welcome fork is answered the sequence counts no progress, and
  // an empty stepper band would still pad the foot of the panel.
  const hasProgress = sequence.some((step) => step.countsAsProgress)

  return (
    <GuideNarrativePanel
      scene={scene}
      sceneKey={sceneKey}
      headline={t(`narrative.${copyKey}.headline`)}
      body={t(`narrative.${copyKey}.body`)}
      copyKey={copyKey}
      overflow="band"
      testIdPrefix="onboarding"
      stepper={
        showStepper && hasProgress ? (
          <StepStepper
            sequence={sequence}
            current={current}
            onStepChange={onStepChange}
            busy={busy}
          />
        ) : undefined
      }
    />
  )
}
