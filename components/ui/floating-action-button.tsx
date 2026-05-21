"use client"

/**
 * FloatingActionButton — Material-style FAB anchored to the bottom-right of the
 * nearest positioned container (defaults to viewport-fixed). Built as a thin
 * wrapper over `Button` so it inherits the design-system tokens and focus
 * ring. Use for the primary affirmative action on a mobile page (e.g. "create
 * new scheduled task").
 */

import * as React from "react"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export interface FloatingActionButtonProps extends Omit<
  React.ComponentProps<typeof Button>,
  "size" | "variant"
> {
  /** Required for accessibility — describes the action this FAB performs. */
  "aria-label": string
  /** Override the default `+` icon. */
  icon?: React.ReactNode
  /**
   * Positioning strategy. `fixed` (default) anchors to viewport;
   * `absolute` anchors to the nearest positioned ancestor (use when the FAB
   * should scroll with a sheet/page rather than the viewport).
   */
  position?: "fixed" | "absolute"
}

export function FloatingActionButton({
  icon,
  className,
  position = "fixed",
  children,
  ...rest
}: FloatingActionButtonProps) {
  return (
    <Button
      data-slot="fab"
      size="icon-lg"
      variant="default"
      className={cn(
        position === "fixed" ? "fixed" : "absolute",
        // Respect iOS safe areas — the inset env vars resolve to 0 on browsers
        // that don't expose them, so this is safe on web too.
        "bottom-[calc(env(safe-area-inset-bottom,0px)+1.25rem)] right-5 z-30 size-14 rounded-full shadow-lg shadow-primary/30 hover:shadow-xl",
        className
      )}
      {...rest}
    >
      {icon ?? <Plus className="size-6" aria-hidden="true" />}
      {children}
    </Button>
  )
}
