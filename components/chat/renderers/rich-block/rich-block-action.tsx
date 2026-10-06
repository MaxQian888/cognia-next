"use client"

/**
 * The one toolbar button every rich block uses (ADR-0218): a 24px ghost icon
 * button with a tooltip and a 14px glyph (20px / 12px in compact frames).
 * Five sizes used to coexist across code, diff, mermaid, math and tables.
 */

import { forwardRef, type ComponentProps } from "react"
import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"
import { cn } from "@/lib/utils"

export interface RichBlockActionProps extends Omit<
  ComponentProps<typeof TooltipIconButton>,
  "tooltip" | "aria-label" | "size"
> {
  /** Translated label, used for the tooltip and the accessible name. */
  label: string
  /** Shorter tooltip text when it should differ from the accessible name. */
  tooltip?: string
  compact?: boolean
}

export const RichBlockAction = forwardRef<HTMLButtonElement, RichBlockActionProps>(
  function RichBlockAction({ label, tooltip, compact = false, className, children, ...rest }, ref) {
    return (
      <TooltipIconButton
        ref={ref}
        type="button"
        variant="ghost"
        size="icon"
        aria-label={label}
        tooltip={tooltip ?? label}
        className={cn(
          "text-muted-foreground hover:text-foreground",
          compact ? "size-5 [&_svg]:size-3" : "size-6 [&_svg]:size-3.5",
          className
        )}
        {...rest}
      >
        {children}
      </TooltipIconButton>
    )
  }
)
