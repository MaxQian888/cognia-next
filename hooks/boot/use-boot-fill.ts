"use client"

/**
 * `useBootFill` — drives a boot screen's progress fill from the shared,
 * monotonic position in `lib/boot/boot-fill.ts`.
 *
 * Three moments, each in the phase that makes it exact:
 *
 *   1. Placement (layout effect). A new fill element is placed where the bar
 *      visibly stood — read after the outgoing owner's layout cleanup, which
 *      React runs in the same commit before this mount's layout effects — with
 *      its transition suppressed, so a hand-over is a seamless continuation
 *      rather than a slide from the inline style's guess.
 *   2. Motion (passive effect). Two beats per step: a short snap to the step's
 *      boundary (the previous step's completion tick; skipped when the bar is
 *      already there), then — once the snap has landed — the long decelerating
 *      creep (`data-creep`) toward the
 *      lean-in target. Both are planned from the bar's *visible* position, so
 *      neither ever moves it backwards. The creep is on a timer, not
 *      `requestAnimationFrame`: rAF is paused in a hidden document, and a boot
 *      that begins backgrounded must still land right when it is shown.
 *   3. Hand-off (layout cleanup). Where the bar visibly stands, mid-transition
 *      included, is recorded for the next owner while the node is still
 *      attached.
 *
 * The returned `initialFill` is the server-safe first value for the inline
 * style: zero for the static export's markup, the remembered position on the
 * client.
 */

import { useEffect, useLayoutEffect, useState, type RefObject } from "react"

import {
  initialBootFill,
  planBootFill,
  readFillFraction,
  rememberBootFill,
} from "@/lib/boot/boot-fill"

/** Below this gap a snap would be invisible; go straight to the creep. */
const SNAP_EPSILON = 0.001

export interface BootFillOptions {
  /** `BootProgressSnapshot.sequence` this mount belongs to. */
  sequence: number
  /** Start boundary of the active step, in [0, 1]. */
  boundary: number
  /** Lean-in target the bar creeps toward while the step runs, in [0, 1]. */
  target: number
  /** Custom property the fill's CSS translates by. */
  property: string
  /**
   * Unscaled length of the snap transition in ms (the CSS value, plus a beat);
   * scaled by `--motion-duration-scale` like the CSS itself.
   */
  snapMs: number
}

export function useBootFill(
  ref: RefObject<HTMLElement | null>,
  { sequence, boundary, target, property, snapMs }: BootFillOptions
): { initialFill: number } {
  const [initialFill] = useState(() => initialBootFill(sequence))

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const previousTransition = el.style.transition
    el.style.transition = "none"
    el.style.setProperty(property, String(initialBootFill(sequence)))
    // Commit the placement before the transition comes back, or the browser
    // would animate from the inline style's value to it.
    void el.offsetWidth
    el.style.transition = previousTransition
    return () => rememberBootFill(sequence, readFillFraction(el, property))
  }, [ref, sequence, property])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const current = readFillFraction(el, property)
    const plan = planBootFill(current, boundary, target)
    rememberBootFill(sequence, plan.snap)
    const creep = () => {
      el.dataset.creep = "true"
      el.style.setProperty(property, String(plan.creep))
    }
    // Already at (or past) the boundary — the opening step, or a re-weighted
    // target inside the same step: no tick to show, keep creeping.
    if (plan.snap - current < SNAP_EPSILON) {
      creep()
      return
    }
    delete el.dataset.creep
    el.style.setProperty(property, String(plan.snap))
    const scale = Number(getComputedStyle(el).getPropertyValue("--motion-duration-scale")) || 1
    const creepAt = window.setTimeout(creep, snapMs * Math.max(0, scale))
    return () => window.clearTimeout(creepAt)
  }, [ref, sequence, boundary, target, property, snapMs])

  return { initialFill }
}
