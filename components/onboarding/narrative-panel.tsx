"use client"

import type { ReactNode } from "react"
import { useTranslations } from "next-intl"
import type { OnboardingStepId } from "@cognia/agent-config-types"

import { StepStepper } from "./step-stepper"
import { cn } from "@/lib/utils"
import type { OnboardingStepDef } from "@/lib/onboarding/steps"

interface NarrativePanelProps {
  /** Which scene to show. Supplied by the flow, drawn by the caller. */
  scene: ReactNode
  /** Step id, used only to key the crossfade between scenes. */
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
 * The left half of the first-run takeover: a brand substrate, the step's
 * scene, a line of narration, and (in the step-by-step path) the progress row.
 *
 * ## What it replaces, and why
 *
 * A `w-[15.5rem] lg:w-[18rem]` rail holding three labels and three
 * descriptions — a sidebar's worth of width spent on nine words, beside a
 * `max-w-[44rem]` content column floating in the middle of a 1440px window.
 * Between them, most of the screen was doing nothing, and every step looked
 * identical because nothing on screen was specific to the step you were on.
 *
 * This panel takes real width (`26rem`, `30rem` at `lg`) and earns it: the
 * scene inside it is drawn from live data, so the scan step's picture differs
 * per machine and the recommended step's picture changes as the plan runs.
 *
 * ## The brand substrate
 *
 * `--brand-action` / `--brand-approval` come verbatim from the marketing
 * site's palette (ADR-0092 V2), which is the point — a user arriving from the
 * website should recognise the first screen. They appear here only as a mesh
 * at 12–18% alpha and as strokes inside the scene, never behind text: the
 * site's own spec measures the cyan at 1.69:1 on a light substrate, so all
 * narration in this panel sits on `--foreground` / `--muted-foreground` over
 * the app's ordinary background.
 *
 * ## Two orientations, one component
 *
 * ```
 * md and up                          below md
 * ┌──────────────┬────────────┐      ┌──────────────────────┐
 * │  mesh        │            │      │ mesh · scene · line  │ ~30vh
 * │  ┌────────┐  │  content   │      ├──────────────────────┤
 * │  │ scene  │  │            │      │  content (scrolls)   │
 * │  └────────┘  │            │      └──────────────────────┘
 * │  headline    │            │
 * │  one line    │            │
 * │  ─ stepper ─ │            │
 * └──────────────┴────────────┘
 * ```
 *
 * Purely responsive rather than breakpoint-switched in JS, so there is no
 * hydration seam and no second component to keep in step. The scene is capped
 * by `max-h` on the narrow layout instead of being swapped for a different
 * drawing — it is one SVG with a fixed viewBox, so it scales cleanly.
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

  return (
    <aside
      data-testid="onboarding-narrative-panel"
      className={cn(
        "relative flex shrink-0 flex-col overflow-hidden border-border/60",
        // Narrow: a band across the top, bounded so a short viewport still
        // leaves the content column usable.
        "h-[30vh] max-h-[15rem] min-h-[9.5rem] w-full border-b",
        // Wide: a full-height column with a hairline trailing edge.
        "md:h-auto md:max-h-none md:w-[26rem] md:border-r md:border-b-0 lg:w-[30rem]"
      )}
    >
      {/* Substrate. Two soft brand stops over the app's own background, so the
          panel reads as a different surface without becoming a different
          product. `pointer-events-none` because it covers the whole panel. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-background"
        style={{
          backgroundImage:
            "radial-gradient(90% 70% at 18% 12%, var(--brand-mesh-from), transparent 70%), radial-gradient(80% 60% at 88% 96%, var(--brand-mesh-to), transparent 72%)",
        }}
      />

      <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6 py-5 md:gap-7 md:px-10 md:py-12">
        <div
          key={sceneKey}
          data-testid="onboarding-scene"
          className="flex w-full min-h-0 max-w-[15rem] flex-1 items-center justify-center md:max-w-[20rem] md:flex-none animate-in fade-in zoom-in-95 duration-300"
        >
          {scene}
        </div>

        <div
          key={`${copyKey}-copy`}
          className="flex w-full flex-col items-center gap-1.5 text-center animate-in fade-in slide-in-from-bottom-1 duration-300 md:gap-2"
        >
          <p
            className="text-balance text-sm font-medium tracking-tight text-foreground md:text-base"
            data-testid="onboarding-narrative-headline"
          >
            {t(`narrative.${copyKey}.headline`)}
          </p>
          {/* The supporting line is the first thing to go when the band is
              short — on a 375×667 phone it would push the scene out. */}
          <p className="hidden max-w-[34ch] text-balance text-xs leading-relaxed text-muted-foreground sm:block md:text-sm">
            {t(`narrative.${copyKey}.body`)}
          </p>
        </div>
      </div>

      {showStepper && (
        <div className="relative shrink-0 px-6 pb-5 md:px-10 md:pb-10">
          <StepStepper
            sequence={sequence}
            current={current}
            onStepChange={onStepChange}
            busy={busy}
            className="justify-center"
          />
        </div>
      )}
    </aside>
  )
}
