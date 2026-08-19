"use client"

/**
 * The state machine behind every shell edge panel's open/collapse animation.
 *
 * A shell edge panel — the conversation sidebar, the nav rail, the status bar,
 * the terminal dock in either slot — animates *the space it occupies* between
 * zero and its own size, so that expanding and collapsing are one transition
 * played in two directions instead of two different gestures with a one-frame
 * layout jump in each. This hook decides when that transition is live.
 *
 * ## Why it is not simply always on
 *
 * Every one of these panels is also *resized* through the same CSS property: a
 * sidebar drag, a dock separator, a window resize. A standing transition turns
 * a drag into a rubber band that lags the pointer, so the transition is armed
 * only for the width of one collapse/expand and then stands down again.
 *
 * ## Why the flag is raised during render
 *
 * The transition class and the new size have to reach the DOM in the *same*
 * commit. A transition only starts when the property is listed in the
 * after-change style, so if any style recalc lands the new size while no
 * transition is declared — and a measuring `getBoundingClientRect()` in a
 * layout effect forces exactly that — there is nothing left to animate and the
 * panel snaps. Adjusting state during render (React's sanctioned "derive state
 * from a changed prop") is what keeps the two in one commit.
 *
 * ## Why a token rather than a boolean
 *
 * A toggle that arrives *during* an animation has to restart the cleanup timer.
 * Re-setting a boolean that is already `true` is a no-op React will not
 * re-run the effect for, so the second collapse would inherit whatever was left
 * of the first one's timer and drop the transition class mid-flight.
 */

import { useEffect, useState, type RefObject } from "react"

import { shellDockAnimationMs } from "@/lib/ui/shell-dock-motion"

export interface EdgePanelTransitionOptions {
  /**
   * Any element inside the panel, as a value or a ref. Only supplies
   * `--motion-duration-scale`, so the cleanup timer waits as long as the CSS
   * actually runs — a fixed timer drops the transition class mid-flight for
   * anyone who has slowed motion down, and the panel snaps the rest of the way.
   *
   * A ref is read inside the effect, never during render, which is the only
   * reason both shapes are accepted: the panels that hold their node in a ref
   * (for measurement) would otherwise have to duplicate it in state.
   */
  element?: Element | null | RefObject<Element | null>
  /**
   * Set `false` for a change that should land instantly — a hand-off rather
   * than an open/close. Defaults to `true`.
   */
  enabled?: boolean
}

/**
 * True while `expanded`'s latest change should be animated.
 *
 * Pass the panel's *expanded* state (or its collapsed state — the hook only
 * reacts to the value changing) and put the returned flag on both the
 * transition class and anything whose teardown has to outlive the motion.
 */
export function useEdgePanelTransition(
  expanded: boolean,
  { element = null, enabled = true }: EdgePanelTransitionOptions = {}
): boolean {
  const [token, setToken] = useState(0)
  const [previousExpanded, setPreviousExpanded] = useState(expanded)
  if (previousExpanded !== expanded) {
    setPreviousExpanded(expanded)
    setToken((n) => n + 1)
  }

  useEffect(() => {
    if (token === 0) return
    const node = element && "current" in element ? element.current : element
    const timer = window.setTimeout(() => setToken(0), shellDockAnimationMs(node))
    return () => window.clearTimeout(timer)
    // `element` is deliberately not a dependency: it only supplies the motion
    // speed multiplier, and re-reading it mid-animation would restart the timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  return token > 0 && enabled
}
