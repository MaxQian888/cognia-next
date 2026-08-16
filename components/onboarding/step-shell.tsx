"use client"

import type { ReactNode } from "react"
import type { OnboardingStepId } from "@cognia/agent-config-types"

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
  // Fills the slot it is given rather than the viewport. On desktop/web the
  // route renders *inside* `DesktopAppShell` (title bar above, guild rail
  // beside, status bar below), so a `h-[100dvh]` shell overflowed by the chrome
  // height and pushed the sticky footer under the status bar. On mobile the
  // wrapper gives `/onboarding` a definite `h-[100dvh]` column, so the same
  // `h-full` chain resolves there too.
  return (
    <div
      className="flex h-full min-h-0 w-full min-w-0 flex-1 bg-muted/20 animate-in fade-in duration-300"
      data-testid="onboarding-shell"
    >
      <StepRail
        sequence={sequence}
        current={current}
        onStepChange={onStepChange}
        onBack={onBack}
        busy={busy}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pt-6 sm:px-10 md:px-16 lg:px-20">
          <StepProgressBar sequence={sequence} current={current} onBack={onBack} busy={busy} />
          {/* Keyed on the step so only the body replays its entrance on each
              transition — the shell, rail and footer stay put. Same motion
              recipe as the settings shell's section swap; the global
              reduce-motion guards in globals.css collapse it to ~1ms. */}
          <div
            key={current}
            className="mx-auto flex w-full max-w-[42rem] flex-1 flex-col justify-center py-6 animate-in fade-in slide-in-from-bottom-2 duration-200"
            data-testid="onboarding-step-body"
          >
            {children}
          </div>
        </div>
        {footer && (
          <div className="shrink-0 border-t bg-background/80 px-6 py-4 backdrop-blur sm:px-10 md:px-16 lg:px-20">
            <div className="mx-auto flex w-full max-w-[42rem] items-center justify-between gap-3">
              {footer}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** Shared heading block so every step's title/description align identically. */
export function StepHeading({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-6 flex flex-col gap-2">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {description && (
        <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
      )}
    </div>
  )
}
