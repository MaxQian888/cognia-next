// Horizontally-scrollable row with edge fade affordances. Pulled out of
// `plugin-panel-tabs.tsx` so the same scroll-overflow treatment can wrap any
// inline-flex strip (devtools sub-tabs, marketplace section toggles, etc.)
// without duplicating styling.
//
// shadcn's `scroll-fade-x` utility owns overflow detection and edge state with
// a CSS scroll-driven mask, so this wrapper needs no listeners or overlay DOM.

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
   * data-testid prefix for the `${testId}-scroller` element.
   * Defaults to "scroll-shadow-row".
   */
  testId?: string
}

export function ScrollShadowRow({
  children,
  className,
  scrollerClassName,
  testId = "scroll-shadow-row",
}: Props) {
  return (
    <div className={cn("relative", className)}>
      <div
        className={cn("scroll-fade-x overflow-x-auto", scrollerClassName)}
        data-testid={`${testId}-scroller`}
      >
        {children}
      </div>
    </div>
  )
}
