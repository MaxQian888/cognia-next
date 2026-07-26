/**
 * Rule between sections or inline controls.
 *
 * Defaults to `decorative` — a bare line is almost always visual grouping the
 * surrounding headings already convey, and announcing every one of them as a
 * separator turns a dense plugin panel into screen-reader noise. Pass
 * `decorative={false}` on the rare divider that carries real structure (e.g. it
 * is the only thing distinguishing two lists), which makes Radix emit
 * `role="separator"` plus `aria-orientation`.
 */
import * as React from "react"
import { Separator as SeparatorPrimitive } from "radix-ui"

import { cn } from "./cn"

function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      data-slot="separator"
      decorative={decorative}
      orientation={orientation}
      // Radix mirrors `orientation` onto `data-orientation`, so the thickness
      // rules can live in one class string instead of branching in JS.
      className={cn(
        "shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px",
        className
      )}
      {...props}
    />
  )
}

export { Separator }
