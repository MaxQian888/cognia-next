"use client"

import { CheckIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import type { OnboardingStepId } from "@cognia/agent-config-types"

import { cn } from "@/lib/utils"
import type { OnboardingStepDef } from "@/lib/onboarding/steps"

interface StepRailProps {
  sequence: readonly OnboardingStepDef[]
  current: OnboardingStepId
  /** Jump back to an already-completed step. Omit to make the rail read-only. */
  onStepChange?: (step: OnboardingStepId) => void
  /** Steps raise this while a request is in flight, locking the rail. */
  busy?: boolean
}

/**
 * The persistent rail: where you are.
 *
 * **Only completed steps are clickable.** Moving forward has to run the
 * current step's validation and submit (the scan step commits a runtime
 * choice; the provider step commits credentials), so jumping ahead from the
 * rail would skip it. Going back is always safe.
 *
 * `welcome` is in the sequence but not in the rail — reading a product intro
 * is not progress toward being set up, and numbering it makes the flow feel
 * longer than it is. `progressPosition` reports `-1` there for the same reason.
 *
 * **Flush, not floating.** It is a full-height column with a hairline on its
 * trailing edge and a tint a step off the page, the same way the app's own
 * columns divide. It used to be a `rounded-2xl` card inset in a padded gutter,
 * with a hard-coded `dark` class that made it a black slab under a light
 * theme — a dialog's geometry and someone else's palette, on a screen that is
 * neither.
 *
 * **Back is not here any more.** It lives in `OnboardingWindowBar`, which
 * exists at every width; this rail is hidden below `md`, so carrying it here
 * meant a second copy in the narrow progress bar.
 */
export function StepRail({ sequence, current, onStepChange, busy = false }: StepRailProps) {
  const t = useTranslations("onboarding")
  const counted = sequence.filter((s) => s.countsAsProgress)
  const currentIndex = counted.findIndex((s) => s.id === current)

  return (
    <nav
      aria-label={t("rail.label")}
      data-testid="onboarding-rail"
      className="hidden w-[15.5rem] shrink-0 flex-col border-r border-border/60 bg-muted/30 px-6 py-9 md:flex lg:w-[18rem] lg:px-8"
    >
      <ol className="flex flex-col">
        {counted.map((step, index) => {
          const done = index < currentIndex
          const isCurrent = index === currentIndex
          const canReturn = done && !!onStepChange && !busy
          const isLast = index === counted.length - 1

          const body = (
            <>
              {/* Bullet + connector share a column so the line always spans
                  exactly the gap between two bullets, whatever the label
                  wraps to. */}
              <span aria-hidden className="flex shrink-0 flex-col items-center self-stretch">
                <span
                  className={cn(
                    "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full ring-1 transition-colors",
                    done
                      ? "bg-foreground text-background ring-foreground"
                      : isCurrent
                        ? "bg-background ring-foreground"
                        : "ring-border"
                  )}
                >
                  {done ? (
                    <CheckIcon className="size-2.5" />
                  ) : isCurrent ? (
                    <span className="block size-1.5 rounded-full bg-foreground" />
                  ) : null}
                </span>
                {!isLast && (
                  <span
                    className={cn(
                      "mt-1.5 w-px flex-1 transition-colors",
                      done ? "bg-foreground/40" : "bg-border"
                    )}
                  />
                )}
              </span>
              <span className="min-w-0 flex-1 text-left">
                <span
                  className={cn(
                    "block text-sm transition-colors",
                    isCurrent
                      ? "font-medium text-foreground"
                      : done
                        ? "text-foreground"
                        : "text-muted-foreground"
                  )}
                >
                  {t(`rail.${step.id}.label`)}
                </span>
                <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                  {t(`rail.${step.id}.description`)}
                </span>
              </span>
            </>
          )

          const rowClass = cn("flex w-full items-stretch gap-3 text-left", !isLast && "pb-8")

          return (
            <li key={step.id} className="flex">
              {canReturn ? (
                <button
                  type="button"
                  onClick={() => onStepChange(step.id)}
                  data-testid={`onboarding-rail-${step.id}`}
                  className={cn(
                    rowClass,
                    "rounded-md transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  )}
                >
                  {body}
                </button>
              ) : (
                <div
                  className={rowClass}
                  data-testid={`onboarding-rail-${step.id}`}
                  {...(isCurrent ? { "aria-current": "step" as const } : {})}
                >
                  {body}
                </div>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

/**
 * The rail's job at widths where the rail itself does not fit. Rendered only
 * below `md`. Segments rather than a repeat of the full list: at 375px the
 * point is to spend as little vertical space as possible, and "which step, how
 * far along" is what the list was communicating anyway.
 *
 * A flush row with its own hairline, not a floating strip inside the body's
 * padding — it is chrome for the column beneath it, and it has to read as the
 * narrow-width stand-in for a bordered rail. Back is not here: the window bar
 * above carries it at every width.
 */
export function StepProgressBar({
  sequence,
  current,
}: Pick<StepRailProps, "sequence" | "current">) {
  const t = useTranslations("onboarding")
  const counted = sequence.filter((s) => s.countsAsProgress)
  const currentIndex = counted.findIndex((s) => s.id === current)

  return (
    <div
      className="flex shrink-0 items-center gap-3 border-b border-border/60 px-6 py-3 md:hidden"
      data-testid="onboarding-progress-bar"
    >
      <span aria-hidden className="flex flex-1 items-center gap-1.5">
        {counted.map((step, index) => (
          <span
            key={step.id}
            className={cn(
              "h-1 flex-1 rounded-full transition-colors",
              index <= currentIndex ? "bg-foreground" : "bg-border"
            )}
          />
        ))}
      </span>
      {currentIndex >= 0 && (
        <span className="min-w-0 truncate text-xs font-medium text-muted-foreground">
          {t(`rail.${counted[currentIndex]!.id}.label`)}
        </span>
      )}
    </div>
  )
}
