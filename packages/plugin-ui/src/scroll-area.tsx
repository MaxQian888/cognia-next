/**
 * Scrollable region with the host's overlay scrollbar look.
 *
 * Plugins render inside host-owned slots whose height is decided by the host
 * (a dock pane, a sheet, a settings section). A plugin that lets a raw
 * `overflow-auto` div grow gets the platform's native scrollbar, which on macOS
 * and Windows looks nothing like the rest of the app. Wrapping content here
 * keeps the chrome consistent and, more importantly, keeps the overflow
 * *inside* the slot instead of pushing the host's own layout around.
 */
import * as React from "react"
import { ScrollArea as ScrollAreaPrimitive } from "radix-ui"

import { cn } from "./cn"

function ScrollArea({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root>) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative flex flex-col overflow-hidden", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        className="h-full w-full grow rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1"
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      {/*
       * Vertical only, matching the host. `children` land in the Viewport, so a
       * caller cannot slot a second scrollbar in from outside; a plugin that
       * genuinely needs a horizontal one composes its own Root/Viewport/ScrollBar
       * from the exported parts rather than nesting two ScrollAreas.
       */}
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      className={cn(
        "flex touch-none p-px transition-colors select-none",
        orientation === "vertical" && "h-full w-2.5 border-l border-l-transparent",
        orientation === "horizontal" && "h-2.5 flex-col border-t border-t-transparent",
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        className="relative flex-1 rounded-full bg-border"
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  )
}

export { ScrollArea, ScrollBar }
