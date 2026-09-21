"use client"

// One menu row for the turn capabilities the composer injects into the `+`
// menus (web search, skills, the room target). The menus own `PanelItem` /
// `PlusRow` for their built-in entries; this is the same anatomy — a
// full-width button with a muted leading icon, a text-sm label, and the
// active dot — so an injected control reads as a menu entry instead of a
// toolbar chip parked inside the list.
//
// Platform-aware like the menus themselves: the desktop popover uses the
// compact hover row, the mobile sheet the thumb-sized touch-target row with
// `active:` feedback (a phone has no hover). `hint` is the mobile-only second
// line — PlusRow's convention for carrying a disabled reason, since there is
// no hover tooltip on touch — while `tooltip` gives desktop hover the same
// explanation.
//
// Checkable semantics differ per platform too: the sheet's rows are menu
// items (`menuitemcheckbox` + `aria-checked`, because `aria-pressed` is not
// defined for menu items), the popover's are plain toggle buttons
// (`aria-pressed`). `checkable` picks the right one — do not hand the row a
// raw `aria-pressed` of your own.

import { forwardRef, type ReactNode } from "react"
import { ChevronRightIcon } from "lucide-react"
import { usePlatform } from "@/hooks/use-platform"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

export interface CapabilityRowProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "children" | "role" | "aria-checked" | "aria-pressed"
> {
  /** Leading glyph — callers pass a `size-4` Lucide icon, like PanelItem. */
  icon: ReactNode
  label: string
  /** Draws the "this is on" dot, matching the menus' checkable rows. */
  active?: boolean
  /** The row toggles a flag — owns `aria-pressed` (desktop) or
      `menuitemcheckbox` + `aria-checked` (mobile). */
  checkable?: boolean
  /** Secondary line under the label — mobile sheet only. */
  hint?: string
  /** The row opens a nested panel — draws the same trailing chevron the
      menus' own drill-down rows do (`size-3.5` desktop, `size-4` mobile). */
  chevron?: boolean
  /** Hover explanation (provider name, disabled reason). */
  tooltip?: ReactNode
}

// forwardRef + prop spread: `PopoverTrigger asChild` (room target) and
// `TooltipTrigger asChild` both clone the child and inject handlers + a ref,
// so the row has to be a real DOM-forwarding host.
export const CapabilityRow = forwardRef<HTMLButtonElement, CapabilityRowProps>(
  function CapabilityRow(
    { icon, label, active, checkable, disabled, hint, chevron, tooltip, className, ...rest },
    ref
  ) {
    const isMobile = usePlatform() === "mobile"
    const row = (
      <button
        ref={ref}
        type="button"
        disabled={disabled}
        role={isMobile ? (checkable ? "menuitemcheckbox" : "menuitem") : undefined}
        aria-checked={isMobile && checkable ? active === true : undefined}
        aria-pressed={!isMobile && checkable ? active === true : undefined}
        // `disabled` alone is not announced on menuitem roles — PlusRow
        // carries `aria-disabled` for the same reason.
        aria-disabled={isMobile && disabled ? true : undefined}
        className={cn(
          "flex w-full items-center text-left text-sm disabled:cursor-not-allowed disabled:opacity-50",
          isMobile
            ? "touch-target gap-3 rounded-control px-2 active:bg-muted/60"
            : "gap-2 rounded px-2 py-1.5 hover:bg-accent",
          active && !isMobile && "text-foreground",
          className
        )}
        {...rest}
      >
        <span className="text-muted-foreground">{icon}</span>
        {isMobile ? (
          <span className="min-w-0 flex-1">
            <span className="block truncate">{label}</span>
            {hint ? (
              <span className="block truncate text-xs text-muted-foreground">{hint}</span>
            ) : null}
          </span>
        ) : (
          <span className="flex-1 truncate">{label}</span>
        )}
        {active ? <span aria-hidden className="size-1.5 rounded-full bg-primary" /> : null}
        {chevron ? (
          <ChevronRightIcon
            aria-hidden
            className={isMobile ? "size-4 text-muted-foreground" : "size-3.5 text-muted-foreground"}
          />
        ) : null}
      </button>
    )
    if (tooltip === undefined || tooltip === null) return row
    return (
      <Tooltip>
        {/* A disabled button swallows pointer events, which is exactly when
            the tooltip matters — it carries the "why". Radix's workaround is
            a block-level span as the trigger around the disabled control. */}
        <TooltipTrigger asChild>
          {disabled ? <span className="block">{row}</span> : row}
        </TooltipTrigger>
        <TooltipContent side="top">{tooltip}</TooltipContent>
      </Tooltip>
    )
  }
)
