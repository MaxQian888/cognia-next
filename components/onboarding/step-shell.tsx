"use client"

import type { ReactNode } from "react"
import type { OnboardingStepId } from "@cognia/agent-config-types"

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
  /** Overrides which `onboarding.narrative.*` entry the panel reads. */
  narrativeKey?: string
  /** Hidden in recommended mode, whose sequence is two screens. */
  showStepper?: boolean
  /** Sticky action row. Kept out of the scroll area so it never scrolls away. */
  footer?: ReactNode
}

/**
 * One shell for the whole flow, rendered by `OnboardingFlow` rather than by
 * each step.
 *
 * Hoisting it is load-bearing, not tidiness. If every step rendered its own
 * shell, React would tear the old one down and build a new one on each
 * transition — because each step is a different component type — remounting
 * the "persistent" panel and replaying its entrance animation. That full-window
 * re-fade is exactly the flash this arrangement avoids; only the step body and
 * the scene swap. (Multica hit this and fixed it the same way.)
 *
 * ## Geometry
 *
 * ```
 * ┌──────────────────────────────────────────────┐
 * │ ← Cognia                             – □ ×   │  window bar (h-10, transparent)
 * ├────────────────────┬─────────────────────────┤
 * │ narrative panel    │  step body (scrolls)    │
 * │  mesh · scene      │                         │
 * │  headline · line   ├─────────────────────────┤
 * │  stepper           │  actions (flush)        │
 * └────────────────────┴─────────────────────────┘
 *      26rem / 30rem
 * ```
 *
 * Below `md` the panel becomes a band across the top and the two halves stack;
 * one component serves both, so there is no second layout to keep in step.
 *
 * **The whole window, not a slot in one.** `/onboarding` suppresses the
 * desktop chrome (`isOnboardingRoute` in `DesktopAppShell`), so this element
 * *is* the window: `h-[100dvh]`, `overflow-hidden`, its own window bar. On
 * mobile the wrapper still hands it a definite `h-[100dvh]` flex column, and
 * `flex-1 min-h-0` wins over the height there — flex-basis governs a column
 * child's main size — so one class list serves both.
 *
 * **What replaced the rail.** The previous version put a `w-[15.5rem]` list of
 * three labels-plus-descriptions on the left and centred a `max-w-[44rem]`
 * column in the remaining space, which left most of a desktop window empty and
 * made all four steps look identical. `NarrativePanel` takes that width and
 * spends it on a picture drawn from live data; `StepStepper` keeps the one
 * thing the rail was actually needed for. The separate below-`md` progress bar
 * is gone with it — the panel exists at every width, so a narrow-width stand-in
 * has nothing left to stand in for.
 */
export function StepShell({
  sequence,
  current,
  onStepChange,
  onBack,
  busy = false,
  children,
  scene,
  narrativeKey,
  showStepper = true,
  footer,
}: StepShellProps) {
  return (
    <div
      className="flex h-[100dvh] min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden bg-background text-foreground safe-area-pt animate-in fade-in duration-300"
      data-testid="onboarding-shell"
    >
      <OnboardingWindowBar onBack={onBack} busy={busy} />

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <NarrativePanel
          scene={scene}
          sceneKey={current}
          narrativeKey={narrativeKey}
          sequence={sequence}
          current={current}
          onStepChange={onStepChange}
          busy={busy}
          showStepper={showStepper}
        />

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            {/* Keyed on the step so only the body replays its entrance on each
                transition — the shell, panel, window bar and actions stay put.
                Same motion recipe as the settings shell's section swap; the
                global reduce-motion guards in globals.css collapse it to ~1ms. */}
            <div
              key={current}
              className="mx-auto flex w-full max-w-[38rem] flex-1 flex-col justify-center px-6 py-8 sm:px-10 lg:py-12 animate-in fade-in slide-in-from-bottom-2 duration-200"
              data-testid="onboarding-step-body"
            >
              {children}
            </div>
          </div>

          {footer && (
            <footer
              className="shrink-0 border-t border-border/60 px-6 py-4 sm:px-10"
              data-testid="onboarding-actions"
            >
              <div className="mx-auto flex w-full max-w-[38rem] items-center justify-between gap-3">
                {footer}
              </div>
            </footer>
          )}
        </div>
      </div>
    </div>
  )
}

/** Shared heading block so every step's title/description align identically. */
export function StepHeading({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-6 flex flex-col gap-2">
      <h1 className="text-balance text-2xl font-semibold tracking-tight sm:text-[1.75rem]">
        {title}
      </h1>
      {description && (
        <p className="max-w-[46ch] text-sm leading-relaxed text-muted-foreground">{description}</p>
      )}
    </div>
  )
}
