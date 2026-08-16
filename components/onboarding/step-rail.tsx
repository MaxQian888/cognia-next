"use client"

import { ArrowLeftIcon, CheckIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import type { OnboardingStepId } from "@cognia/agent-config-types"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { OnboardingStepDef } from "@/lib/onboarding/steps"

interface StepRailProps {
  sequence: readonly OnboardingStepDef[]
  current: OnboardingStepId
  /** Jump back to an already-completed step. Omit to make the rail read-only. */
  onStepChange?: (step: OnboardingStepId) => void
  onBack?: () => void
  /** Steps raise this while a request is in flight, locking Back and the rail. */
  busy?: boolean
}

/**
 * The persistent rail: where you are, and how to go back.
 *
 * **Only completed steps are clickable.** Moving forward has to run the
 * current step's validation and submit (the scan step commits a runtime
 * choice; the provider step commits credentials), so jumping ahead from the
 * rail would skip it. Going back is always safe.
 *
 * `welcome` is in the sequence but not in the rail — reading a product intro
 * is not progress toward being set up, and numbering it makes the flow feel
 * longer than it is. `progressPosition` reports `-1` there for the same reason.
 */
export function StepRail({ sequence, current, onStepChange, onBack, busy = false }: StepRailProps) {
  const t = useTranslations("onboarding")
  const counted = sequence.filter((s) => s.countsAsProgress)
  const currentIndex = counted.findIndex((s) => s.id === current)

  return (
    <aside className="hidden w-[15rem] shrink-0 p-3 md:block lg:w-[19rem] lg:p-4">
      <div className="dark relative flex h-full w-full flex-col overflow-hidden rounded-2xl bg-background px-5 py-6 text-foreground ring-1 ring-border">
        <header className="flex min-h-9 shrink-0 items-center justify-between gap-3">
          <span className="truncate text-sm font-medium">{t("wordmark")}</span>
          {onBack && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={onBack}
              disabled={busy}
              aria-label={t("back")}
              data-testid="onboarding-rail-back"
            >
              <ArrowLeftIcon className="size-4" />
            </Button>
          )}
        </header>

        <nav
          className="flex min-h-0 flex-1 flex-col justify-center gap-6 py-10"
          aria-label={t("rail.label")}
        >
          {counted.map((step, index) => {
            const done = index < currentIndex
            const isCurrent = index === currentIndex
            const canReturn = done && !!onStepChange && !busy

            const body = (
              <>
                <span
                  aria-hidden
                  className={cn(
                    "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full ring-1 transition-colors",
                    done
                      ? "bg-foreground text-background ring-foreground"
                      : isCurrent
                        ? "ring-muted-foreground"
                        : "ring-border"
                  )}
                >
                  {done ? (
                    <CheckIcon className="size-3" />
                  ) : isCurrent ? (
                    <span className="block size-1.5 rounded-full bg-foreground" />
                  ) : null}
                </span>
                <span className="min-w-0 flex-1 text-left">
                  <span
                    className={cn(
                      "block text-sm transition-colors",
                      isCurrent || done ? "text-foreground" : "text-muted-foreground"
                    )}
                  >
                    {t(`rail.${step.id}.label`)}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {t(`rail.${step.id}.description`)}
                  </span>
                </span>
              </>
            )

            return canReturn ? (
              <button
                key={step.id}
                type="button"
                onClick={() => onStepChange(step.id)}
                data-testid={`onboarding-rail-${step.id}`}
                className="flex w-full items-start gap-3 rounded-md text-left transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {body}
              </button>
            ) : (
              <div
                key={step.id}
                className="flex w-full items-start gap-3"
                data-testid={`onboarding-rail-${step.id}`}
                {...(isCurrent ? { "aria-current": "step" as const } : {})}
              >
                {body}
              </div>
            )
          })}
        </nav>
      </div>
    </aside>
  )
}

/**
 * The rail's job at widths where the rail itself does not fit. Rendered only
 * below `md`. Segments rather than a repeat of the full list: at 375px the
 * point is to spend as little vertical space as possible, and "which step, how
 * far along" is what the list was communicating anyway.
 *
 * It carries the Back button too. Leaving that to the rail stranded every step
 * but the first with no way back on a phone — the exact width where the whole
 * flow now runs.
 */
export function StepProgressBar({
  sequence,
  current,
  onBack,
  busy = false,
}: Omit<StepRailProps, "onStepChange">) {
  const t = useTranslations("onboarding")
  const counted = sequence.filter((s) => s.countsAsProgress)
  const currentIndex = counted.findIndex((s) => s.id === current)

  return (
    <div className="mb-6 flex items-center gap-3 md:hidden">
      {onBack && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="-ml-2 size-8 shrink-0"
          onClick={onBack}
          disabled={busy}
          aria-label={t("back")}
          data-testid="onboarding-bar-back"
        >
          <ArrowLeftIcon className="size-4" />
        </Button>
      )}
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
