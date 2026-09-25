"use client"

/**
 * A reason that is reachable by hover, keyboard AND touch.
 *
 * The plugin surfaces explained themselves in hover-only Radix Tooltips and
 * HoverCards: why Install is disabled, why a plugin is "Not available here",
 * what a signature state means, which tools a capability chip stands for. On
 * the Capacitor shell nothing hovers, so every one of those reasons was
 * unreachable, and several triggers were bare `<span>`s a keyboard could not
 * focus either.
 *
 * `PluginHint` renders ONE focusable `<button>` trigger (with an accessible
 * name) and picks the disclosure by input capability: a Tooltip where the
 * primary pointer can hover, a tap-to-open Popover where it cannot. The
 * content is the same either way. `useHasHover` answers from the same
 * `(hover: hover)` media query the CSS uses, so the two never disagree.
 */

import type { ReactNode } from "react"

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { useHasHover } from "@/hooks/ui/use-pointer"
import { cn } from "@/lib/utils"

export interface PluginHintProps {
  /**
   * Accessible name of the trigger. Must contain the trigger's visible text
   * when it has any (WCAG 2.5.3 label-in-name), and must say what an
   * icon-only trigger means.
   */
  label: string
  /** The explanation. */
  content: ReactNode
  /** What the trigger paints (a badge, an icon). */
  children: ReactNode
  /** Classes for the trigger button. */
  className?: string
  contentClassName?: string
  side?: "top" | "right" | "bottom" | "left"
  align?: "start" | "center" | "end"
  testId?: string
}

export function PluginHint({
  label,
  content,
  children,
  className,
  contentClassName,
  side = "top",
  align = "center",
  testId,
}: PluginHintProps) {
  const hasHover = useHasHover()

  const trigger = (
    <button
      type="button"
      aria-label={label}
      data-testid={testId}
      // `touch-hit` extends the hit area vertically on coarse pointers (see
      // app/globals.css) without growing the badge it wraps.
      className={cn(
        "touch-hit inline-flex max-w-full shrink-0 items-center rounded-md outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
        className
      )}
    >
      {children}
    </button>
  )

  if (hasHover) {
    return (
      // Self-contained provider: these hints render in stories, dialogs and
      // unit tests with no `app/layout.tsx` above them.
      <TooltipProvider delayDuration={150}>
        <Tooltip>
          <TooltipTrigger asChild>{trigger}</TooltipTrigger>
          <TooltipContent side={side} align={align} className={contentClassName}>
            <div className="max-w-64 space-y-1 text-xs">{content}</div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  return (
    <Popover>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        side={side}
        align={align}
        className={cn("w-auto max-w-[min(18rem,calc(100vw-2rem))] p-3", contentClassName)}
      >
        <div className="space-y-1 text-xs">{content}</div>
      </PopoverContent>
    </Popover>
  )
}
