"use client"

import type { ReactNode } from "react"
import type { OnboardingStepId } from "@cognia/agent-config-types"

import { GuideHeading } from "@/components/guide/guide-heading"
import { GuideShell } from "@/components/guide/guide-shell"
import { NarrativePanel } from "./narrative-panel"
import { OnboardingWindowBar } from "./window-bar"
import type { OnboardingStepDef } from "@/lib/onboarding/steps"

interface StepShellProps {
  sequence: readonly OnboardingStepDef[]
  current: OnboardingStepId
  onStepChange?: (step: OnboardingStepId) => void
  onBack?: () => void
  busy?: boolean
  children: ReactNode
  /** The step's narrative scene, rendered into the panel. */
  scene: ReactNode
  /**
   * Keys the scene's crossfade. Defaults to the step; overridden where one
   * step shows more than one picture (the recommended screen's ready phase).
   */
  sceneKey?: string
  /** Overrides which `onboarding.narrative.*` entry the panel reads. */
  narrativeKey?: string
  /** Hidden in recommended mode, whose sequence is two screens. */
  showStepper?: boolean
  /** Sticky action row. Kept out of the scroll area so it never scrolls away. */
  footer?: ReactNode
}

/**
 * One shell for the whole first-run flow, rendered by `OnboardingFlow` rather
 * than by each step — the shared `GuideShell` with the onboarding window bar
 * and narrative panel (ADR-0122, ADR-0141, ADR-0193).
 *
 * Hoisting it is load-bearing, not tidiness: each step is a different
 * component type, so a shell per step would remount the "persistent" panel and
 * replay the whole window's entrance on every transition. Only the step body
 * and the scene swap.
 *
 * `/onboarding` suppresses the desktop chrome (`isOnboardingRoute` in
 * `DesktopAppShell`), so this element *is* the window. Geometry and motion
 * live in `components/guide/`, which `/pair` renders into too — the two
 * first-contact screens are one design now, not two copies of it.
 */
export function StepShell({
  sequence,
  current,
  onStepChange,
  onBack,
  busy = false,
  children,
  scene,
  sceneKey,
  narrativeKey,
  showStepper = true,
  footer,
}: StepShellProps) {
  return (
    <GuideShell
      testIdPrefix="onboarding"
      overflow="band"
      bodyKey={current}
      windowBar={<OnboardingWindowBar onBack={onBack} busy={busy} />}
      panel={
        <NarrativePanel
          scene={scene}
          sceneKey={sceneKey ?? current}
          narrativeKey={narrativeKey}
          sequence={sequence}
          current={current}
          onStepChange={onStepChange}
          busy={busy}
          showStepper={showStepper}
        />
      }
      footer={footer}
    >
      {children}
    </GuideShell>
  )
}

/** Shared heading block so every step's title/description align identically. */
export function StepHeading({ title, description }: { title: string; description?: string }) {
  return <GuideHeading title={title} description={description} />
}
