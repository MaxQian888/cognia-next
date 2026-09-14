"use client"

/**
 * The floating action bar's parts: a bar drawn in the inverse of the page, and
 * the buttons on it.
 *
 * Two surfaces float actions over reading material — the multi-message
 * selection bar above the composer (`transcript-selection-bar.tsx`) and the
 * phone's "Select text" sheet (`components/mobile/chat/message-text-selection-sheet.tsx`).
 * The inverse ground is what keeps either from reading as one more input: the
 * composer right below is the page's own colour. Sharing the parts keeps the
 * two identical in weight, hover and touch size.
 */

import type { ComponentProps } from "react"
import type { LucideIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * The ground. Callers add the shape: a pill in a wide pane, a card in a narrow
 * one or at the foot of a sheet.
 */
export const FLOATING_BAR_CLASS = "bg-foreground text-background"

/**
 * A button on that ground. The ghost variant's hover is a light wash meant for a
 * light page, so it is replaced in both themes.
 */
export const FLOATING_BAR_BUTTON_CLASS =
  "text-background hover:bg-background/15 hover:text-background dark:hover:bg-background/15 focus-visible:ring-background/40 disabled:opacity-40"

export interface FloatingBarActionProps extends Omit<ComponentProps<typeof Button>, "children"> {
  label: string
  icon: LucideIcon
  /**
   * Inside the message list: the label sits under the icon while the pane is
   * narrow and beside it once the pane is wide (`@xl/message-list`). Without
   * it the label always sits under the icon, which is the only layout where
   * four labelled actions fit one row a thumb can read.
   */
  adaptive?: boolean
}

export function FloatingBarAction({
  label,
  icon: Icon,
  adaptive = false,
  className,
  ...props
}: FloatingBarActionProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      title={label}
      className={cn(
        FLOATING_BAR_BUTTON_CLASS,
        // Explicit `has-[>svg]` padding: the size variant sets its own, which
        // would otherwise outrank a plain `px-*`.
        "h-auto min-w-0 flex-col gap-1 px-1 py-2 text-[11px] font-normal has-[>svg]:px-1 pointer-coarse:min-h-14",
        adaptive &&
          "@xl/message-list:h-8 @xl/message-list:min-h-0 @xl/message-list:flex-row @xl/message-list:gap-1.5 @xl/message-list:rounded-pill @xl/message-list:py-0 @xl/message-list:text-xs @xl/message-list:has-[>svg]:px-2.5",
        className
      )}
      {...props}
    >
      <Icon className={cn("size-4", adaptive && "@xl/message-list:size-3.5")} aria-hidden />
      {/* Stacked, a label may take two lines: "Save as memory" is wider than a
          quarter of a 375pt phone, and an ellipsis there hides the verb. */}
      <span
        className={cn(
          "line-clamp-2 max-w-full text-center leading-tight whitespace-normal",
          adaptive && "@xl/message-list:line-clamp-1 @xl/message-list:whitespace-nowrap"
        )}
      >
        {label}
      </span>
    </Button>
  )
}
