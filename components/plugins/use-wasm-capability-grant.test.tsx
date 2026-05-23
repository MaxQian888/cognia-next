"use client"

// Horizontally-scrollable row with edge fade affordances. Pulled out of
// `plugin-panel-tabs.tsx` so the same scroll-overflow treatment can wrap any
// inline-flex strip (devtools sub-tabs, marketplace section toggles, etc.)
// without duplicating the ResizeObserver wiring.
//
// The fade overlays render only when the inner scroller actually overflows,
// matching the pattern users already see on the main plugin tab strip.

import { useRef } from "react"
import { useOverflowState } from "@/hooks/use-overflow-state"
import { cn } from "@/lib/utils"

interface Props {
  children: React.ReactNode
  /** Extra classes applied to the outer wrapper (relative positioning host). */
  className?: string
  /**
   * Extra classes applied to the inner scroller. Callers commonly pass
   * `-mx-1 px-1` style negative-margin tricks here.
   */
  scrollerClassName?: string
  /**
   * data-testid prefix. The scroller gets `${testId}-scroller`, fades get
   * `${testId}-fade-left` / `${testId}-fade-right`. Defaults to "scroll-shadow-row".
   */
  testId?: string
}

export function ScrollShadowRow({
  children,
  className,
  scrollerClassName,
  testId = "scroll-shadow-row",
}: Props) {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const { hasOverflowLeft, hasOverflowRight } = useOverflowState(scrollerRef)

  return (
    <div className={cn("relative", className)}>
      <div
        ref={scrollerRef}
        className={cn("overflow-x-auto", scrollerClassName)}
        data-testid={`${testId}-scroller`}
      >
        {children}
      </div>
      {hasOverflowLeft && (
        <span
          aria-hidden
          data-testid={`${testId}-fade-left`}
          className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-background to-transparent"
        />
      )}
      {hasOverflowRight && (
        <span
          aria-hidden
          data-testid={`${testId}-fade-right`}
          className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-background to-transparent"
        />
      )}
    </div>
  )
}
