"use client"

import { useEffect, useRef, useState } from "react"
import { useCountUp } from "@web/hooks/use-count-up"
import { resolveObserverFactory, type ObserverFactory } from "@web/lib/intersection"
import { cn } from "@web/lib/utils"

interface CountUpProps {
  /**
   * A number counts up; a string renders verbatim. The evidence pipeline emits
   * both shapes — `52` and `"AGPL-3.0-or-later"` sit side by side in the same
   * stat row — so the component takes the union rather than making every caller
   * branch.
   */
  value: string | number
  className?: string
  durationMs?: number
  /** Injected for tests, whose IntersectionObserver stub never fires. */
  createObserver?: ObserverFactory
}

/**
 * **Tally**, rendered (ADR-0092 §6).
 *
 * Starts once the element reaches the viewport, so the count is something the
 * reader arrives at rather than something that already finished while they were
 * elsewhere on the page.
 *
 * `tabular-nums` is not cosmetic: without it the digits change width as they
 * climb and the stat row reflows on every frame.
 */
export function CountUp({ value, className, durationMs, createObserver }: CountUpProps) {
  const ref = useRef<HTMLSpanElement>(null)
  const [inView, setInView] = useState(false)
  const numeric = typeof value === "number"

  useEffect(() => {
    if (!numeric) return
    const node = ref.current
    if (!node) return
    // No IntersectionObserver (jsdom, or an old engine) means the count simply
    // never starts — and because the hook renders the real value until then,
    // the fallback is the correct number rather than a zero.
    const factory = resolveObserverFactory(createObserver)
    if (!factory) return

    const observer = factory(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true)
          observer.disconnect()
        }
      },
      { threshold: 0.4 }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [numeric, createObserver])

  const counted = useCountUp({
    to: numeric ? value : 0,
    start: inView && numeric,
    ...(durationMs === undefined ? {} : { durationMs }),
  })

  return (
    <span ref={ref} className={cn(numeric && "tabular-nums", className)}>
      {numeric ? counted : value}
    </span>
  )
}
