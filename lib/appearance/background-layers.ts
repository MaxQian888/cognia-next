/**
 * The DOM half of the wallpaper transition: staging an image on the hidden
 * layer and flipping `data-bg-phase` so CSS animates the swap.
 *
 * Split out of `background-applier.tsx` because the ordering here is the part
 * that is easy to get subtly wrong and impossible to eyeball. Three things
 * have to happen in a specific order for a directional transition to look
 * right, and two of them are invisible:
 *
 *   1. The incoming layer is moved to its ENTRY position with transitions
 *      suppressed, otherwise it visibly slides from wherever it last rested.
 *   2. A reflow is forced, so the browser commits that position as the start
 *      of the animation rather than coalescing it with step 3.
 *   3. The outgoing layer is given its EXIT position in the same frame as the
 *      phase flip, which is the only moment its role is known. This is what
 *      lets both layers travel the same direction during a slide instead of
 *      crossing through each other.
 *
 * One invariant runs through the whole file: `data-bg-two-layer` and
 * `data-bg-scrim` are never set at the same time, because they contend for the
 * same `::after` pseudo-element. `normalizeToSingleLayer` is how a stack that
 * is mid-rotation gets folded back down before the scrim goes up.
 */

import {
  inactivePhase,
  imageVarFor,
  slideOffset,
  TRANSITION_ATTRS,
  TRANSITION_VARS,
  type BackgroundPhase,
  type TransitionPlan,
} from "@/lib/appearance/wallpaper-transition"
import { BG_VARS } from "@/lib/appearance/background-fit"

/** Attribute marking that layer B is live. Mutually exclusive with the scrim. */
export const ATTR_TWO_LAYER = "data-bg-two-layer"
/** Attribute suppressing transitions for one frame while a layer is staged. */
export const ATTR_ARMING = "data-bg-arming"

/** Extra blur, in px, applied through the midpoint of a `dissolve`. */
export const DISSOLVE_BLUR_PX = 14

/** Read the phase currently painted, defaulting to layer A. */
export function currentPhase(body: HTMLElement): BackgroundPhase {
  return body.getAttribute(TRANSITION_ATTRS.phase) === "b" ? "b" : "a"
}

/** The CSS transform a layer holds while hidden, per transition. */
export function entryTransform(plan: TransitionPlan): string {
  switch (plan.effective) {
    case "slide": {
      const { x, y } = slideOffset(plan.slideDirection)
      return `translate3d(${x}, ${y}, 0)`
    }
    case "zoom":
      return "scale(1.08)"
    default:
      return "none"
  }
}

/** The CSS transform the outgoing layer travels to, per transition. */
export function exitTransform(plan: TransitionPlan): string {
  switch (plan.effective) {
    case "slide": {
      const { x, y } = slideOffset(plan.slideDirection)
      // Negated so the leaving layer continues in the same direction the
      // arriving one is travelling, rather than the two crossing.
      return `translate3d(calc(-1 * ${x}), calc(-1 * ${y}), 0)`
    }
    case "zoom":
      return "scale(0.96)"
    default:
      return "none"
  }
}

/**
 * Fold a two-layer stack back onto layer A without a visible flicker.
 *
 * Called before the scrim goes up, and whenever a transition stops being
 * two-layer. The image currently showing is copied onto layer A first, so
 * clearing `data-bg-two-layer` (which deletes `::after`) cannot blank the
 * wallpaper while the phase still says "b".
 */
export function normalizeToSingleLayer(body: HTMLElement): void {
  const phase = currentPhase(body)
  if (phase === "b") {
    const showing = body.style.getPropertyValue(TRANSITION_VARS.imageB)
    if (showing) body.style.setProperty(TRANSITION_VARS.imageA, showing)
  }
  body.setAttribute(ATTR_ARMING, "true")
  body.setAttribute(TRANSITION_ATTRS.phase, "a")
  body.removeAttribute(ATTR_TWO_LAYER)
  body.style.setProperty(TRANSITION_VARS.durationMs, "0ms")
  body.style.setProperty(TRANSITION_VARS.transformA, "none")
  body.style.setProperty(TRANSITION_VARS.transformB, "none")
  forceReflow(body)
  body.removeAttribute(ATTR_ARMING)
}

export interface WriteTimingArgs {
  body: HTMLElement
  plan: TransitionPlan
}

/** Publish the plan's duration, easing and name so CSS can act on them. */
export function writeTransitionTiming({ body, plan }: WriteTimingArgs): void {
  body.style.setProperty(TRANSITION_VARS.durationMs, `${plan.durationMs}ms`)
  body.style.setProperty(TRANSITION_VARS.easing, plan.easingCss)
  body.setAttribute(TRANSITION_ATTRS.transition, plan.effective)
}

export interface StageArgs {
  body: HTMLElement
  /** Resolved `background-image` CSS for the incoming wallpaper. */
  cssValue: string
  plan: TransitionPlan
}

/**
 * Run a two-layer transition. Returns the phase now showing.
 *
 * Safe to call when the stack is currently single-layer: layer B is armed and
 * given the incoming image in the same suppressed frame, so its first appearance
 * is already at the entry position.
 */
export function crossfadeToLayer({ body, cssValue, plan }: StageArgs): BackgroundPhase {
  const from = currentPhase(body)
  const to = inactivePhase(from)

  body.setAttribute(ATTR_ARMING, "true")
  body.setAttribute(ATTR_TWO_LAYER, "true")
  body.style.setProperty(imageVarFor(to), cssValue)
  body.style.setProperty(transformVarFor(to), entryTransform(plan))
  writeTransitionTiming({ body, plan })
  forceReflow(body)
  body.removeAttribute(ATTR_ARMING)

  // Same frame as the flip: only now is the outgoing layer's role known.
  body.style.setProperty(transformVarFor(from), exitTransform(plan))
  body.setAttribute(TRANSITION_ATTRS.phase, to)
  return to
}

/** The transform variable belonging to a phase. */
export function transformVarFor(phase: BackgroundPhase): string {
  return phase === "a" ? TRANSITION_VARS.transformA : TRANSITION_VARS.transformB
}

export interface FadeArgs extends StageArgs {
  /** Target opacity to return to, which is the user's configured value. */
  opacity: number
  /** Injectable for tests. Defaults to `setTimeout`. */
  schedule?: (fn: () => void, ms: number) => number
}

/**
 * Run a one-layer fade: dip the visible layer out, swap the image underneath,
 * bring it back.
 *
 * This is the transition used wherever the second layer is unavailable, so it
 * deliberately touches only layer A and the opacity variable. Returns a
 * canceller, because a rotation that advances again mid-fade must not have the
 * old timer restore an opacity that belongs to a wallpaper two swaps ago.
 */
export function fadeToImage(args: FadeArgs): () => void {
  const { body, cssValue, plan, opacity } = args
  const schedule = args.schedule ?? ((fn, ms) => window.setTimeout(fn, ms))

  normalizeToSingleLayer(body)
  writeTransitionTiming({ body, plan })
  body.style.setProperty(BG_VARS.opacity, "0")

  let cancelled = false
  const timer = schedule(() => {
    if (cancelled) return
    body.style.setProperty(TRANSITION_VARS.imageA, cssValue)
    body.style.setProperty(BG_VARS.opacity, `${opacity}`)
  }, plan.durationMs)

  return () => {
    cancelled = true
    if (typeof window !== "undefined") window.clearTimeout(timer)
  }
}

export interface DissolveBlurArgs {
  body: HTMLElement
  plan: TransitionPlan
  /** The user's configured blur, restored when the dissolve completes. */
  restoreBlurPx: number
  schedule?: (fn: () => void, ms: number) => number
}

/**
 * Ramp blur up and back down across a `dissolve`, so the swap reads as a
 * defocus rather than a wipe. Returns a canceller for the same reason
 * {@link fadeToImage} does.
 */
export function rampDissolveBlur(args: DissolveBlurArgs): () => void {
  const { body, plan, restoreBlurPx } = args
  const schedule = args.schedule ?? ((fn, ms) => window.setTimeout(fn, ms))

  body.style.setProperty(BG_VARS.blur, `${restoreBlurPx + DISSOLVE_BLUR_PX}px`)
  let cancelled = false
  const timer = schedule(
    () => {
      if (cancelled) return
      body.style.setProperty(BG_VARS.blur, `${restoreBlurPx}px`)
    },
    Math.max(1, Math.round(plan.durationMs / 2))
  )

  return () => {
    cancelled = true
    if (typeof window !== "undefined") window.clearTimeout(timer)
  }
}

/**
 * Read the element's layout to force a style flush.
 *
 * `offsetHeight` is the cheapest property that is guaranteed to require layout.
 * The void cast is load-bearing, not decoration: without it a minifier is free
 * to drop the read and the staged position gets coalesced into the flip.
 */
export function forceReflow(element: HTMLElement): void {
  void element.offsetHeight
}
