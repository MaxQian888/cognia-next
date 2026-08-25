"use client"

import * as React from "react"
import { Progress as ProgressPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Progress({
  className,
  value,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      // `value` is forwarded, not just consumed by the transform below. The
      // upstream shadcn snippet destructures it away, which leaves Radix with
      // no value to publish and the bar with no `aria-valuenow` — visually
      // determinate, accessibly indeterminate. Determinate regions
      // (`LoadingRegion progress={...}`) depend on Radix emitting it.
      value={value}
      className={cn("relative h-2 w-full overflow-hidden rounded-pill bg-primary/20", className)}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="h-full w-full flex-1 bg-primary transition-all"
        style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
