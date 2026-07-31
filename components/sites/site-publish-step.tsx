"use client"

import type { ReactNode } from "react"
import { CheckCircle2Icon, CircleAlertIcon, Loader2Icon } from "lucide-react"

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
  /** The step's action controls. */
  children?: ReactNode
}

/**
 * One row of the progressive publish flow. Purely presentational: the parent
 * derives `state` from live Dexie data and localizes every string. The running
 * spinner is gated behind `motion-safe:` so reduced-motion users get a static
 * indicator, and the sub-status line is an `aria-live` region so screen readers
 * hear each operation event as it lands.
 */
export function SitePublishStep({
  index,
  title,
  description,
  state,
  stateLabel,
  subStatus,
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
          <Loader2Icon className="size-4 text-primary motion-safe:animate-spin" />
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
        {children ? <div className="pt-1">{children}</div> : null}
      </div>
    </div>
  )
}
