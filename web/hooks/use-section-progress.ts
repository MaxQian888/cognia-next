"use client"

import { useEffect, useState } from "react"
import { resolveObserverFactory, type ObserverFactory } from "@web/lib/intersection"

export interface SectionObservation {
  id: string
  isIntersecting: boolean
  ratio: number
}

/**
 * Choose the section a reader is currently on.
 *
 * Exported and pure because this is where all the judgement lives, and because
 * it is the only part that can be tested directly: `jest.setup.ts` stubs
 * `IntersectionObserver` with a no-op whose callback never fires, so a test
 * driving the hook end to end would assert nothing. Same split as
 * `web/lib/evidence.ts` — I/O outside, decisions inside.
 *
 * Ties break toward the earlier section in document order rather than the
 * larger ratio: while scrolling down, two neighbours are briefly both in the
 * band, and preferring the later one makes the marker jump ahead of the
 * heading the reader is actually looking at.
 */
export function pickActive(
  observations: SectionObservation[],
  order: readonly string[],
  previous: string
): string {
  const visible = observations.filter((o) => o.isIntersecting && o.ratio > 0)
  // Nothing in the band — between two sections, or past the last one. Holding
  // the previous choice is what keeps the rail from blanking out mid-scroll.
  if (visible.length === 0) return previous

  let best = visible[0]
  for (const candidate of visible) {
    const candidateIndex = order.indexOf(candidate.id)
    const bestIndex = order.indexOf(best.id)
    if (candidateIndex !== -1 && (bestIndex === -1 || candidateIndex < bestIndex)) {
      best = candidate
    }
  }
  return best.id
}

interface UseSectionProgressOptions {
  /** Section ids, in document order. */
  sections: readonly string[]
  /** Injected for tests, whose IntersectionObserver stub never fires. */
  createObserver?: ObserverFactory
}

/**
 * Track which of a page's sections the reader is on.
 *
 * The observation band is the middle tenth of the viewport
 * (`-45% 0px -45% 0px`), so "current" means "crossing the middle of the
 * screen" rather than "touching the edge" — with full-height sections, an
 * edge-triggered rule would mark a section active while it is still a sliver.
 */
export function useSectionProgress({
  sections,
  createObserver,
}: UseSectionProgressOptions): string {
  const [active, setActive] = useState(sections[0] ?? "")

  useEffect(() => {
    const factory = resolveObserverFactory(createObserver)
    if (!factory) return

    const nodes = sections
      .map((id) => document.getElementById(id))
      .filter((node): node is HTMLElement => node !== null)
    if (nodes.length === 0) return

    const observer = factory(
      (entries) => {
        const observations = entries.map((entry) => ({
          id: entry.target.id,
          isIntersecting: entry.isIntersecting,
          ratio: entry.intersectionRatio,
        }))
        setActive((previous) => pickActive(observations, sections, previous))
      },
      { rootMargin: "-45% 0px -45% 0px", threshold: [0, 0.01] }
    )

    for (const node of nodes) observer.observe(node)
    return () => observer.disconnect()
  }, [sections, createObserver])

  return active
}
