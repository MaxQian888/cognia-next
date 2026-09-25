"use client"

import type { ReactNode } from "react"
import { XIcon, type LucideIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { GUIDE_CALLOUT_ENTER } from "./guide-motion"
import { cn } from "@/lib/utils"

export interface GuideCalloutDismiss {
  onDismiss: () => void
  /** Accessible name of the close button. Required: it is an icon alone. */
  label: string
  testId?: string
}

export interface GuideCalloutProps {
  /**
   * `bar` — one row across the top of the app chrome (the finish-setup
   * notice). `card` — a block inside a page (a settings banner).
   */
  variant?: "bar" | "card"
  /**
   * `brand` for "here is a next step", `attention` for "something did not
   * finish". Tone is carried by the surface and the icon tile, never by the
   * text colour — both brand tints are below text contrast on a light ground.
   */
  tone?: "brand" | "attention"
  icon: LucideIcon
  title: string
  description?: string
  /** Buttons, chips, links — the callout's way forward. */
  actions?: ReactNode
  /** Extra material under the description (card only). */
  children?: ReactNode
  dismiss?: GuideCalloutDismiss
  testId?: string
  className?: string
}

const SURFACE: Record<NonNullable<GuideCalloutProps["tone"]>, string> = {
  brand: "border-brand-action/25 bg-brand-wash",
  attention: "border-brand-approval/35 bg-brand-approval/8",
}

const ICON_TILE: Record<NonNullable<GuideCalloutProps["tone"]>, string> = {
  brand: "bg-brand-action/15",
  attention: "bg-brand-approval/20",
}

/**
 * The in-app guide surface (ADR-0193).
 *
 * Everything that points a user back toward setup from inside the app — the
 * finish-setup bar under the title bar, the "get started" banner on the
 * provider page, the setup-status block in Settings → Discover — used to be a
 * different component with a different look: a muted strip, a dashed card with
 * a sparkles tile, a bare heading and a button. They are one kind of thing, a
 * guide surfacing its next step, so they share one surface, one icon tile, one
 * close button in one place, and one entrance.
 *
 * The `bar` variant is a live notice (`role="status"`) because it appears on
 * its own when something is missing; the `card` variant is page content, a
 * labelled region the user navigated to.
 */
export function GuideCallout({
  variant = "card",
  tone = "brand",
  icon: Icon,
  title,
  description,
  actions,
  children,
  dismiss,
  testId,
  className,
}: GuideCalloutProps) {
  const dismissButton = dismiss && (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
      onClick={dismiss.onDismiss}
      aria-label={dismiss.label}
      data-testid={dismiss.testId}
    >
      <XIcon className="size-3.5" />
    </Button>
  )

  if (variant === "bar") {
    return (
      <div
        role="status"
        data-testid={testId}
        data-variant="bar"
        data-tone={tone}
        className={cn(
          "flex items-center gap-3 border-b px-4 py-1.5 text-xs",
          SURFACE[tone],
          GUIDE_CALLOUT_ENTER,
          className
        )}
      >
        <span
          aria-hidden
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-md",
            ICON_TILE[tone]
          )}
        >
          <Icon className="size-3.5 text-foreground" />
        </span>
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium text-foreground">{title}</span>
          {description && <span className="text-muted-foreground"> · {description}</span>}
        </span>
        {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
        {dismissButton}
      </div>
    )
  }

  return (
    <section
      aria-label={title}
      data-testid={testId}
      data-variant="card"
      data-tone={tone}
      className={cn(
        "flex items-start gap-3 rounded-xl border px-4 py-3",
        SURFACE[tone],
        GUIDE_CALLOUT_ENTER,
        className
      )}
    >
      <span
        aria-hidden
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-lg",
          ICON_TILE[tone]
        )}
      >
        <Icon className="size-4.5 text-foreground" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {description && (
          <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
        )}
        {children}
        {actions && <div className="flex flex-wrap items-center gap-2 pt-1.5">{actions}</div>}
      </div>
      {dismissButton && <div className="-mt-1 -mr-2 shrink-0">{dismissButton}</div>}
    </section>
  )
}
