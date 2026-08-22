"use client"

import { CheckIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import type { OnboardingStepId } from "@cognia/agent-config-types"

import { cn } from "@/lib/utils"
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
 * Where you are, in one horizontal row.
 *
 * Replaces the 18rem vertical rail. That rail carried a label *and* a
 * description per step — three lines of prose to say "you are on step two of
 * three" — inside a column wide enough to hold a sidebar. The description is
 * the step's own heading restated, so it went; what is left is position, which
 * is the only thing the rail was ever needed for now that the narrative panel
 * beside it says what the step is about.
 *
 * **Only completed steps are clickable**, carried over unchanged from the
 * rail: moving forward has to run the current step's submit (the scan step
 * commits a runtime choice, the sign-in step commits credentials), so jumping
 * ahead would skip it. Going back is always safe.
 *
 * **Recommended mode does not render this at all.** Its sequence is two
 * screens, one of which is the intro — a progress row reading "1 of 1" tells
 * the user nothing except that they took the short path, which is not a thing
 * they need reminding of. Its progress is the plan lines completing.
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
  const currentIndex = counted.findIndex((s) => s.id === current)

  if (counted.length === 0) return null

  return (
    <nav
      aria-label={t("rail.label")}
      data-testid="onboarding-stepper"
      className={cn("flex items-center gap-2", className)}
    >
      <ol className="flex min-w-0 flex-1 items-center gap-2">
        {counted.map((step, index) => {
          const done = index < currentIndex
          const isCurrent = index === currentIndex
          const canReturn = done && !!onStepChange && !busy
          const label = t(`rail.${step.id}.label`)

          const marker = (
            <span
              aria-hidden
              className={cn(
                "flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-medium ring-1 transition-colors",
                done
                  ? "bg-brand-action/15 text-foreground ring-brand-action"
                  : isCurrent
                    ? "bg-background text-foreground ring-foreground"
                    : "text-muted-foreground ring-border"
              )}
            >
              {done ? <CheckIcon className="size-3" /> : index + 1}
            </span>
          )

          return (
            <li key={step.id} className="flex min-w-0 items-center gap-2">
              {canReturn ? (
                <button
                  type="button"
                  onClick={() => onStepChange(step.id)}
                  data-testid={`onboarding-rail-${step.id}`}
                  className="flex min-w-0 items-center gap-2 rounded-md transition-opacity hover:opacity-75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {marker}
                  <span className="truncate text-xs text-foreground">{label}</span>
                </button>
              ) : (
                <span
                  className="flex min-w-0 items-center gap-2"
                  data-testid={`onboarding-rail-${step.id}`}
                  {...(isCurrent ? { "aria-current": "step" as const } : {})}
                >
                  {marker}
                  <span
                    className={cn(
                      "truncate text-xs transition-colors",
                      isCurrent ? "font-medium text-foreground" : "text-muted-foreground",
                      // Below `sm` only the active label has room; the markers
                      // alone still carry position.
                      !isCurrent && "hidden sm:inline"
                    )}
                  >
                    {label}
                  </span>
                </span>
              )}
              {index < counted.length - 1 && (
                <span
                  aria-hidden
                  className={cn(
                    "h-px w-4 shrink-0 transition-colors sm:w-6",
                    done ? "bg-brand-action/50" : "bg-border"
                  )}
                />
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
