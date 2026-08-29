"use client"

import { Surface } from "@/components/surface/surface"
import type { ReactNode } from "react"
import { CheckCircle2Icon, CircleAlertIcon } from "lucide-react"

import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import type { SiteStepState } from "@/hooks/sites/use-site-live-data"

export interface SitePublishStepProps {
  /** 1-based position shown in the idle badge. */
  index: number
  title: string
  description?: string
  state: SiteStepState
  /** Accessible label for the status indicator (already localized). */
  stateLabel: string
  /** Live sub-status line shown only while running (from the op event stream). */
  subStatus?: string
  /** Blocking problem for this step — a failure message or an unmet precondition. */
  error?: string
  /** Non-blocking note, e.g. why the step's controls are disabled on this host. */
  hint?: string
  /** The step's action controls. */
  children?: ReactNode
}

/**
 * One row of the progressive publish flow. Purely presentational: the parent
 * derives `state` from live Dexie data and localizes every string.
 *
 * The running indicator is the shared `Spinner`. It previously hand-rolled
 * `motion-safe:animate-spin`, which froze the glyph for reduced-motion users —
 * but the reduced-motion tier in `app/globals.css` deliberately exempts
 * `.animate-spin`, because removing distraction must not remove status. The
 * sub-status line is an `aria-live` region so screen readers hear each
 * operation event as it lands.
 */
export function SitePublishStep({
  index,
  title,
  description,
  state,
  stateLabel,
  subStatus,
  error,
  hint,
  children,
}: SitePublishStepProps) {
  return (
    <div data-state={state} className="flex gap-3">
      <div
        role="img"
        aria-label={stateLabel}
        className={cn(
          "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border text-sm font-medium",
          state === "idle" && "text-muted-foreground",
          state === "done" && "border-primary/40 text-primary",
          state === "failed" && "border-destructive/40 text-destructive"
        )}
      >
        {state === "running" ? (
          <Spinner className="size-4 text-primary" />
        ) : state === "done" ? (
          <CheckCircle2Icon className="size-4" />
        ) : state === "failed" ? (
          <CircleAlertIcon className="size-4" />
        ) : (
          index
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-2 pb-1">
        <div>
          <div className="font-medium">{title}</div>
          {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
        </div>
        {state === "running" && subStatus ? (
          <p role="status" className="text-xs text-muted-foreground">
            {subStatus}
          </p>
        ) : null}
        {error ? (
          <Surface
            asChild
            layer="raised"
            radius="control"
            className="border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-xs text-destructive"
          >
            <p role="alert">{error}</p>
          </Surface>
        ) : null}
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
        {children ? <div className="pt-1">{children}</div> : null}
      </div>
    </div>
  )
}
