"use client"

/**
 * The shared read-out chip for the Inbox conversation header.
 *
 * Fourteen chips each hand-spelled the same `Tooltip > TooltipTrigger asChild >
 * Badge > TooltipContent` tree and their own size string, so they drifted:
 * three different heights, three different paddings, two different text sizes.
 * This is that tree, once.
 *
 * ## What it deliberately does not offer
 *
 * A responsive-visibility prop. Four of those chips still carried
 * `hidden md:inline-flex` from when they lived in the header STRIP, where
 * hiding them on a narrow screen kept the row from overflowing the pane. They
 * moved into the overflow popover, which is not width-constrained, and the
 * class came with them: on a phone, SLA state, quiet hours, the @-strategy and
 * the topic runtime rendered nowhere at all. Not offering the escape hatch is
 * what stops that returning.
 *
 * Chips that own a menu or a popover of their own (`lifecycle-status-chip`,
 * `assignee-chip`, `adapter-health-badge`, `outbound-status-pill`) are not
 * built on this: their trigger is a Button, not a Badge, and forcing them
 * through here would mean a prop for every one of their differences.
 */

import type { ReactNode } from "react"

import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

type BadgeVariant = React.ComponentProps<typeof Badge>["variant"]

export interface InboxChipProps {
  /** Leading glyph. Sized by the chip, so pass the icon component unstyled. */
  icon?: ReactNode
  variant?: BadgeVariant
  children: ReactNode
  /** Hover / focus explanation. A chip with no tooltip renders the badge bare. */
  tooltip?: ReactNode
  "aria-label"?: string
  role?: string
  "data-testid"?: string
  className?: string
  /**
   * Extra `data-*` attributes. Several chips expose their state this way for
   * their own tests (`data-count`, `data-active`, `data-policy`), and passing
   * them through keeps those contracts without a prop each.
   */
  dataAttributes?: Record<string, string | number | boolean | undefined>
}

export function InboxChip({
  icon,
  variant = "outline",
  children,
  tooltip,
  "aria-label": ariaLabel,
  role,
  "data-testid": testId,
  className,
  dataAttributes,
}: InboxChipProps) {
  const badge = (
    <Badge
      variant={variant}
      // `items-center gap-1 text-xs` is the whole of the shared sizing. It is
      // here rather than in each chip so the row reads as one control strip.
      className={cn("items-center gap-1 text-xs", className)}
      {...(ariaLabel ? { "aria-label": ariaLabel } : {})}
      {...(role ? { role } : {})}
      {...(testId ? { "data-testid": testId } : {})}
      {...dataAttributes}
    >
      {icon}
      {children}
    </Badge>
  )

  if (!tooltip) return badge

  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent className="text-xs">{tooltip}</TooltipContent>
    </Tooltip>
  )
}
