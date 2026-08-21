"use client"

import type { ReactNode } from "react"
import type { OnboardingStepId } from "@cognia/agent-config-types"

import { OnboardingWindowBar } from "./window-bar"
import { StepProgressBar, StepRail } from "./step-rail"
import type { OnboardingStepDef } from "@/lib/onboarding/steps"

interface StepShellProps {
  sequence: readonly OnboardingStepDef[]
  current: OnboardingStepId
  onStepChange?: (step: OnboardingStepId) => void
  onBack?: () => void
  busy?: boolean
  children: ReactNode
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
 * the "persistent" rail and replaying its entrance animation. That full-window
 * re-fade is exactly the flash this arrangement avoids; only the step body
 * swaps. (Multica hit this and fixed it the same way.)
 *
 * ## Geometry
 *
 * ```
 * ┌─────────────────────────────────────────────┐
 * │ ← Cognia                            – □ ×   │  window bar (h-10, transparent)
 * ├───────────────┬─────────────────────────────┤
 * │  step rail    │  step body (scrolls)        │
 * │  (flush,      │                             │
 * │   border-r)   ├─────────────────────────────┤
 * │               │  actions (flush, border-t)  │
 * └───────────────┴─────────────────────────────┘
 * ```
 *
 * **The whole window, not a slot in one.** `/onboarding` suppresses the
 * desktop chrome (`isOnboardingRoute` in `DesktopAppShell`), so this element
 * *is* the window: `h-[100dvh]`, `overflow-hidden`, its own window bar. The
 * shell used to fill a slot between the title bar, guild rail and status bar,
 * which meant setup rendered inside a frame for the app it was still setting
 * up. On mobile the wrapper still hands it a definite `h-[100dvh]` flex
 * column, and `flex-1 min-h-0` wins over the height there — flex-basis
 * governs a column child's main size — so one class list serves both.
 *
 * **Square at the window edges, rounded only inside.** Every panel here is
 * flush: the rail is a full-height column with a hairline on its trailing
 * edge, the action row is a hairline above it, and nothing floats. The two
 * radii in the flow both belong to the design system — `rounded-xl` for the
 * selectable cards (what `components/ui/card.tsx` uses) and the buttons' own
 * `rounded-md`. The version this replaces floated a `rounded-2xl` rail card in
 * a padded gutter beside flush, square content, so the same screen argued with
 * itself about whether it was a page or a dialog.
 */
export function StepShell({
  sequence,
  current,
  onStepChange,
  onBack,
  busy = false,
  children,
  footer,
}: StepShellProps) {
  return (
    <div
      className="flex h-[100dvh] min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden bg-background text-foreground safe-area-pt animate-in fade-in duration-300"
      data-testid="onboarding-shell"
    >
      <OnboardingWindowBar onBack={onBack} busy={busy} />

      <div className="flex min-h-0 flex-1">
        <StepRail sequence={sequence} current={current} onStepChange={onStepChange} busy={busy} />

        <div className="flex min-w-0 flex-1 flex-col">
          {/* The rail's job at widths where the rail does not fit. Outside the
              scroll area so "which step" stays on screen while the body
              scrolls. */}
          <StepProgressBar sequence={sequence} current={current} />

          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            {/* Keyed on the step so only the body replays its entrance on each
                transition — the shell, rail, window bar and actions stay put.
                Same motion recipe as the settings shell's section swap; the
                global reduce-motion guards in globals.css collapse it to ~1ms. */}
            <div
              key={current}
              className="mx-auto flex w-full max-w-[44rem] flex-1 flex-col justify-center px-6 py-10 sm:px-10 lg:py-14 animate-in fade-in slide-in-from-bottom-2 duration-200"
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
              <div className="mx-auto flex w-full max-w-[44rem] items-center justify-between gap-3">
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
    <div className="mb-7 flex flex-col gap-2">
      <h1 className="text-balance text-2xl font-semibold tracking-tight sm:text-[1.75rem]">
        {title}
      </h1>
      {description && (
        <p className="max-w-[46ch] text-sm leading-relaxed text-muted-foreground">{description}</p>
      )}
    </div>
  )
}
