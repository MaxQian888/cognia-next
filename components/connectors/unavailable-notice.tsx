"use client"

/**
 * The shape a "you cannot do that here, and here is why" read-out takes.
 *
 * Two vocabularies feed it and they must not be conflated. `CapabilityNotice`
 * answers what the *platform* gives this bot — a missing Slack scope, a
 * reaction QQ only offers in guild channels. `ConnectorHostNotice` answers
 * whether *this host* can drive the controls at all. A Telegram bot with every
 * capability is still unconfigurable from a standalone browser, and a desktop
 * with full reach still cannot make WeCom quote a message; collapsing the two
 * would produce a read-out that is wrong half the time in each direction.
 *
 * What they DO share is the presentation, and the rule behind it: reason
 * first, then a next step only when one exists. Some causes are terminal, and
 * a layout that padded them out to look actionable would undo the point.
 */

import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

export interface UnavailableNoticeProps {
  reason: string
  /** Omitted for causes with nothing to do about them. */
  nextStep?: string | null
  /** Machine-readable cause, surfaced as `data-cause` for tests and styling. */
  cause: string
  /** Rendered after the text — a button that performs the next step. */
  action?: ReactNode
  className?: string
  "data-testid"?: string
}

export function UnavailableNotice({
  reason,
  nextStep,
  cause,
  action,
  className,
  "data-testid": testId,
}: UnavailableNoticeProps) {
  return (
    <div
      className={cn("space-y-1.5 text-xs text-muted-foreground", className)}
      data-testid={testId}
      data-cause={cause}
      role="note"
    >
      <p>
        {reason}
        {nextStep ? ` ${nextStep}` : null}
      </p>
      {action}
    </div>
  )
}
