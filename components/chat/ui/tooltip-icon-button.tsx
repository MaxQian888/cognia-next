"use client"

/**
 * TooltipIconButton — the canonical "icon button with hover tooltip" wrapper
 * used across the chat block renderers (code/diff/image/math/mermaid) and
 * elsewhere. Replaces the 40+ inline `<Tooltip><TooltipTrigger asChild>
 * <Button …><Icon/></Button></TooltipTrigger><TooltipContent>…</TooltipContent>
 * </Tooltip>` blocks that used to litter the codebase.
 *
 * Defaults match the legacy inline pattern: `variant="ghost"`, `size="icon-sm"`.
 */

import * as React from "react"

import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

type ButtonProps = React.ComponentProps<typeof Button>

export interface TooltipIconButtonProps extends Omit<ButtonProps, "children" | "aria-label"> {
  /** Content shown inside the button — usually a single Lucide icon. */
  children: React.ReactNode
  /** Tooltip content. Use a translated string. */
  tooltip: React.ReactNode
  /**
   * Required accessible label. Defaults to the tooltip text when it's a string,
   * but pass it explicitly when the tooltip contains markup.
   */
  "aria-label": string
  /** Tooltip alignment override. */
  side?: React.ComponentProps<typeof TooltipContent>["side"]
}

export const TooltipIconButton = React.forwardRef<HTMLButtonElement, TooltipIconButtonProps>(
  function TooltipIconButton(
    { children, tooltip, side, className, variant = "ghost", size = "icon-sm", ...rest },
    ref
  ) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button ref={ref} variant={variant} size={size} className={cn(className)} {...rest}>
            {children}
          </Button>
        </TooltipTrigger>
        <TooltipContent side={side}>{tooltip}</TooltipContent>
      </Tooltip>
    )
  }
)
