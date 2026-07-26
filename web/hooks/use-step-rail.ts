"use client"

import { useCallback, useEffect, useState } from "react"

export interface StepRail {
  index: number
  playing: boolean
  atStart: boolean
  atEnd: boolean
  next: () => void
  previous: () => void
  goTo: (index: number) => void
  toggle: () => void
}

interface StepRailOptions {
  total: number
  /** Autoplay halts here and waits. -1 disables the halt. */
  stopAt?: number
  intervalMs?: number
  /** Autoplay never starts when true; every step is rendered at once instead. */
  reducedMotion?: boolean
}

/**
 * State for the signature task rail (spec §6.1, §6.3).
 *
 * Two behaviours here are requirements rather than preferences:
 *
 *  - Autoplay stops at the approval step and stays there. The point of the
 *    section is that a human decision blocks the work, so the animation has to
 *    sit on that state long enough to be read, not slide past it.
 *  - Any manual interaction cancels autoplay permanently. A control that fights
 *    the reader for the position is worse than no control.
 *
 * `playing` is *derived*, not synchronised. Reaching the halt, or the reader
 * asking for reduced motion, both make it false without an effect writing state
 * — an effect that sets state schedules a second render for something already
 * knowable, and it hides where the decision is actually made. `resumedPastHalt`
 * carries the one fact that genuinely is a decision: the reader chose to
 * continue past the approval gate.
 */
export function useStepRail({
  total,
  stopAt = -1,
  intervalMs = 2600,
  reducedMotion = false,
}: StepRailOptions): StepRail {
  const [index, setIndex] = useState(0)
  const [playRequested, setPlayRequested] = useState(true)
  const [resumedPastHalt, setResumedPastHalt] = useState(false)

  const halted = stopAt >= 0 && index >= stopAt && !resumedPastHalt
  const playing = playRequested && !reducedMotion && !halted && total > 1

  const clamp = useCallback(
    (value: number) => Math.min(Math.max(value, 0), Math.max(total - 1, 0)),
    [total]
  )

  const goTo = useCallback(
    (value: number) => {
      setPlayRequested(false)
      setIndex(clamp(value))
    },
    [clamp]
  )

  const next = useCallback(() => {
    setPlayRequested(false)
    setIndex((current) => clamp(current + 1))
  }, [clamp])

  const previous = useCallback(() => {
    setPlayRequested(false)
    setIndex((current) => clamp(current - 1))
  }, [clamp])

  /**
   * Pressing play at the halt means "continue past the approval gate", which is
   * a different intent from resuming a paused run and has to be recorded as
   * such — otherwise the derived `halted` would immediately stop it again.
   */
  const toggle = useCallback(() => {
    if (halted) {
      setResumedPastHalt(true)
      setPlayRequested(true)
      return
    }
    setPlayRequested((value) => !value)
  }, [halted])

  useEffect(() => {
    if (!playing) return
    const timer = setTimeout(() => {
      setIndex((current) => (current + 1 >= total ? current : current + 1))
    }, intervalMs)
    return () => clearTimeout(timer)
  }, [playing, index, total, intervalMs])

  return {
    index,
    playing,
    atStart: index === 0,
    atEnd: index >= total - 1,
    next,
    previous,
    goTo,
    toggle,
  }
}
