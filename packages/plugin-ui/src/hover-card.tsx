import * as React from "react"
import { HoverCard as HoverCardPrimitive } from "radix-ui"

import { cn } from "./cn"

/**
 * Pointer-triggered preview card.
 *
 * Like every layered component in this kit, it exists because a plugin has no
 * `react-dom` (see `lib/plugin/core/shared-modules.ts`) and therefore no
 * `createPortal`: without a host-provided primitive, plugin content could not
 * escape its slot's overflow/stacking context and a preview would be clipped.
 * Radix's own portal is used here — the host mounts and controls it.
 *
 * Hover-only by design: Radix deliberately does NOT open a HoverCard on
 * keyboard focus or touch, so it must never carry information available
 * nowhere else. Use `Tooltip` for a label, `Sheet` for content that must be
 * reachable by every input method.
 */
function HoverCard({ ...props }: React.ComponentProps<typeof HoverCardPrimitive.Root>) {
  return <HoverCardPrimitive.Root data-slot="hover-card" {...props} />
}

function HoverCardTrigger({ ...props }: React.ComponentProps<typeof HoverCardPrimitive.Trigger>) {
  return <HoverCardPrimitive.Trigger data-slot="hover-card-trigger" {...props} />
}

function HoverCardContent({
  className,
  align = "center",
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Content>) {
  return (
    <HoverCardPrimitive.Portal data-slot="hover-card-portal">
      <HoverCardPrimitive.Content
        data-slot="hover-card-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          // `origin-(--radix-hover-card-content-transform-origin)` makes the
          // zoom animation grow out of the trigger's edge after Radix has
          // flipped/shifted the card to fit the viewport — a fixed origin would
          // animate from the wrong corner on a collision.
          "z-50 w-64 origin-(--radix-hover-card-content-transform-origin) rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-hidden data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          className
        )}
        {...props}
      />
    </HoverCardPrimitive.Portal>
  )
}

export { HoverCard, HoverCardContent, HoverCardTrigger }
