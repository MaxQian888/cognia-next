"use client"

import { CheckIcon } from "lucide-react"

import { cn } from "@/lib/utils"

export interface GuideStepperItem {
  id: string
  label: string
}

export type GuideStepStatus = "done" | "current" | "todo"

export interface GuideStepperProps {
  items: readonly GuideStepperItem[]
  /** Id of the step being shown. An id not in `items` marks every step todo. */
  current: string
  /** Jump back to a completed step. Omit to make the row read-only. */
  onSelect?: (id: string) => void
  /** Raised while a request is in flight; locks the row. */
  busy?: boolean
  /** Accessible name of the row ("Setup progress", "Pairing progress"). */
  ariaLabel: string
  /** Test id of the row itself. */
  testId: string
  /** Each step's control carries `${itemTestIdPrefix}-${id}` when given. */
  itemTestIdPrefix?: string
  className?: string
}

/**
 * Where you are in a guided flow, as one compact row (ADR-0193).
 *
 * `/onboarding` and `/pair` each drew this row by hand — same marker, same
 * hairline, different label rules and different hooks for assistive tech — so
 * the two first-contact screens disagreed about something as small as whether
 * a finished step's label is legible. This is the one row both render.
 *
 * **Only completed steps are clickable.** Moving forward has to run the
 * current step's own submit (a runtime choice, a credential, a pairing), so a
 * jump ahead would skip it. Going back is always safe, and only offered when
 * the caller supplies `onSelect`.
 *
 * **Below `sm` only the current label shows.** The markers alone still carry
 * position, and three labels across a 375px band push the scene out.
 *
 * The connector is a fixed hairline, not `flex-1`: its job is to say "these
 * are in sequence", not to fill whatever width the layout happens to have.
 */
export function GuideStepper({
  items,
  current,
  onSelect,
  busy = false,
  ariaLabel,
  testId,
  itemTestIdPrefix,
  className,
}: GuideStepperProps) {
  const currentIndex = items.findIndex((item) => item.id === current)

  if (items.length === 0) return null

  return (
    <nav aria-label={ariaLabel} data-testid={testId} className={cn("flex items-center", className)}>
      <ol className="flex min-w-0 items-center gap-2">
        {items.map((item, index) => {
          const status: GuideStepStatus =
            currentIndex < 0 || index > currentIndex
              ? "todo"
              : index === currentIndex
                ? "current"
                : "done"
          const canReturn = status === "done" && !!onSelect && !busy
          const itemTestId = itemTestIdPrefix ? `${itemTestIdPrefix}-${item.id}` : undefined

          const content = (
            <>
              <span
                aria-hidden
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-medium ring-1 transition-colors",
                  status === "done" && "bg-brand-action/15 text-foreground ring-brand-action",
                  status === "current" && "bg-background text-foreground ring-foreground",
                  status === "todo" && "text-muted-foreground ring-border"
                )}
              >
                {status === "done" ? <CheckIcon className="size-3" /> : index + 1}
              </span>
              <span
                className={cn(
                  "truncate text-xs transition-colors",
                  status === "current" && "font-medium text-foreground",
                  status === "done" && "text-foreground",
                  status === "todo" && "text-muted-foreground",
                  status !== "current" && "hidden sm:inline"
                )}
              >
                {item.label}
              </span>
            </>
          )

          return (
            <li
              key={item.id}
              className="flex min-w-0 items-center gap-2"
              data-status={status}
              {...(status === "current" ? { "aria-current": "step" as const } : {})}
            >
              {canReturn ? (
                <button
                  type="button"
                  onClick={() => onSelect(item.id)}
                  data-testid={itemTestId}
                  className="flex min-w-0 items-center gap-2 rounded-md transition-opacity hover:opacity-75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {content}
                </button>
              ) : (
                <span className="flex min-w-0 items-center gap-2" data-testid={itemTestId}>
                  {content}
                </span>
              )}
              {index < items.length - 1 && (
                <span
                  aria-hidden
                  className={cn(
                    "h-px w-4 shrink-0 transition-colors sm:w-6",
                    status === "done" ? "bg-brand-action/50" : "bg-border"
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
