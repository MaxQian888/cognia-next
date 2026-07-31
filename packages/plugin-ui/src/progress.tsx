/**
 * Determinate progress bar.
 *
 * Leaving `value` undefined puts Radix into its indeterminate state, but the
 * indicator below still translates by a concrete amount, so an omitted `value`
 * reads as 0% rather than "unknown". A plugin with no measurable progress
 * should show a `Skeleton` instead.
 *
 * Carries no label — pass `aria-label` or `aria-labelledby`, or the bar reaches
 * screen readers as an unnamed progressbar. Radix supplies `aria-valuetext`
 * itself as a locale-neutral percentage; override it with `getValueLabel` when
 * the plugin has a translated string to offer.
 */
import * as React from "react"
import { Progress as ProgressPrimitive } from "radix-ui"

import { cn } from "./cn"

function Progress({
  className,
  value,
  max,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  // Radix's own fallback for an absent/nonsensical `max`, mirrored so the
  // indicator's geometry can never disagree with the aria-value* Radix emits.
  const resolvedMax = typeof max === "number" && max > 0 ? max : 100
  // Clamped because a plugin driving `value={done} max={total}` will transiently
  // overshoot while `total` catches up; unclamped that leaves a gap at the start
  // of the track rather than a full bar.
  const percent = Math.min(100, Math.max(0, ((value ?? 0) / resolvedMax) * 100))

  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      // Deliberate divergence from the host component, which destructures
      // `value` and never hands it back: without these Radix stays permanently
      // `indeterminate` and emits no aria-valuenow, so the bar is visible to
      // sighted users and silent to everyone else. A plugin cannot work around
      // it from outside, so the fix has to live here.
      value={value}
      max={max}
      className={cn("relative h-2 w-full overflow-hidden rounded-full bg-primary/20", className)}
      {...props}
    >
      {/*
       * A full-width bar slid out of view by an inline transform, not a width
       * animation: transforms stay on the compositor, so a plugin ticking this
       * every frame costs the host no layout.
       */}
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="h-full w-full flex-1 bg-primary transition-all"
        style={{ transform: `translateX(-${100 - percent}%)` }}
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
