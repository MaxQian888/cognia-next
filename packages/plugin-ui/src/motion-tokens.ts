/**
 * Shared UI motion tokens — the single source of truth for the animation
 * curves used by the host *and* by plugins.
 *
 * These lived in the app (`lib/ui/motion.ts`) and 85 host modules import them
 * from there. They moved here rather than being copied because the dependency
 * has to point outward: this package must resolve with zero `@/` paths, so a
 * plugin can only share the host's motion vocabulary if the vocabulary itself
 * is the leaf. `lib/ui/motion.ts` is now a re-export shim over this file, which
 * is why the host call sites did not have to change.
 *
 * The values match the system spring used by iOS UIKit (cubic ease-out at
 * ~280 ms). They feel reasonable on Android and on desktop pointer input —
 * long enough to register but short enough that the surface stays responsive
 * under repeated interaction. The `MOBILE_*` export prefixes are retained
 * for backwards compatibility but the tokens are cross-surface.
 */

import { useSyncExternalStore } from "react"
import type { Transition, Variants } from "motion/react"

/** iOS-style cubic-bezier ease. Use for translations, slides, sheets. */
export const MOBILE_EASE = [0.32, 0.72, 0, 1] as [number, number, number, number]

/** Durations in seconds (motion/react convention). */
export const MOBILE_DURATION = {
  fast: 0.18,
  normal: 0.28,
  slow: 0.42,
} as const

export type MobileDurationKey = keyof typeof MOBILE_DURATION

/**
 * Spring for surfaces that track a *selection* rather than play a timed
 * transition — a shared-layout indicator sliding between tab stops, a chip
 * settling into place, a press releasing.
 *
 * Duration-based easing is wrong for these: the distance varies with how far
 * the selection jumped, so a fixed duration reads sluggish for a neighbouring
 * tap and abrupt for a long one. The damping is deliberately high enough that
 * it settles without a visible bounce — the overshoot is what separates
 * "responsive" from "toy".
 */
export const MOBILE_SPRING: Transition = {
  type: "spring",
  stiffness: 420,
  damping: 36,
  mass: 0.7,
}

/** Stagger spacing (seconds) for list enter animations. */
export const STAGGER_INTERVAL = 0.04

/** Pause (seconds) before the first child of a staggered list starts. */
export const STAGGER_DELAY_CHILDREN = 0.02

/**
 * Longest (seconds) the *starts* of a staggered reveal may be spread over,
 * however many children there are. At the plain 40 ms interval a 50-row list
 * would take two seconds before its last row even began to move, which reads
 * as the list loading slowly rather than arriving. Six rows still get the full
 * interval (5 × 0.04 = 0.2); past that the interval tightens instead.
 */
export const STAGGER_MAX_SPREAD = 0.2

/** Standard list child variants: fade + slide-up 8px. */
export const STAGGER_CHILD: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: 8 },
}

/** Container with `staggerChildren` for use with motion.ul / motion.div + STAGGER_CHILD. */
export const STAGGER_CONTAINER: Variants = {
  initial: {},
  animate: {
    transition: {
      staggerChildren: STAGGER_INTERVAL,
      delayChildren: STAGGER_DELAY_CHILDREN,
    },
  },
}

/**
 * The per-child stagger interval for a list of `count` children: the standard
 * `STAGGER_INTERVAL`, tightened so the last child starts no later than
 * `STAGGER_MAX_SPREAD` after the first.
 */
export function staggerIntervalFor(count: number): number {
  if (!Number.isFinite(count) || count <= 1) return STAGGER_INTERVAL
  return Math.min(STAGGER_INTERVAL, STAGGER_MAX_SPREAD / (count - 1))
}

/**
 * `STAGGER_CONTAINER` sized for `count` children. Returns the shared constant
 * itself whenever the cap does not bite, so short lists keep the exact
 * variants object every other staggered surface uses.
 */
export function staggerContainerFor(count: number): Variants {
  const interval = staggerIntervalFor(count)
  if (interval === STAGGER_INTERVAL) return STAGGER_CONTAINER
  return {
    initial: {},
    animate: {
      transition: {
        staggerChildren: interval,
        delayChildren: STAGGER_DELAY_CHILDREN,
      },
    },
  }
}

/** Reusable enter transition built from the tokens. */
export function mobileTransition(durationKey: MobileDurationKey = "normal"): Transition {
  return {
    duration: MOBILE_DURATION[durationKey],
    ease: MOBILE_EASE,
  }
}

/*
 * Reduced motion — the same three markers `app/globals.css` keys its guard off,
 * so JS-driven motion and CSS-driven motion always agree:
 *
 *   - `html.reduce-motion` — written by `motion-applier` (Settings →
 *     Appearance → A11y). An explicit user opt-in.
 *   - `html[data-reduce-motion="true"]` — written by `SettingsSyncProvider`
 *     from the persisted `reduceMotion` setting. Also an explicit opt-in.
 *   - the OS `prefers-reduced-motion: reduce` hint — honoured UNLESS
 *     `html[data-motion-respect="off"]`, the opt-out for users who want full
 *     motion despite the OS setting.
 *
 * Checking only the OS query (what motion's own `useReducedMotion` does)
 * ignores the app's switch, and it also never re-reads the query after mount.
 * The markers are re-derived here rather than imported because this package may
 * not reach into the app.
 */

/** Class `motion-applier` puts on `<html>` for the in-app opt-in. */
export const REDUCE_MOTION_CLASS = "reduce-motion"

/** Attribute (`"true"`) `SettingsSyncProvider` puts on `<html>` for the persisted opt-in. */
export const REDUCE_MOTION_ATTRIBUTE = "data-reduce-motion"

/** Attribute whose value `"off"` stops the OS hint from reducing motion. */
export const MOTION_RESPECT_ATTRIBUTE = "data-motion-respect"

/** The OS hint — the same media query the host stylesheet uses. */
export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)"

/** Every `<html>` attribute whose change can flip the reduced-motion answer. */
const REDUCED_MOTION_ATTRIBUTES = ["class", REDUCE_MOTION_ATTRIBUTE, MOTION_RESPECT_ATTRIBUTE]

/**
 * Probe the OS hint. Wrapped in try/catch because jsdom and some embedded
 * webviews implement `matchMedia` only partially — a throwing probe must
 * degrade to "animate", never crash inside a render.
 */
function reducedMotionQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null
  try {
    return window.matchMedia(REDUCED_MOTION_QUERY)
  } catch {
    return null
  }
}

/**
 * Whether motion should be suppressed right now. `false` outside a browser:
 * during a static export there is no user and no preference, and defaulting to
 * "reduce" would ship a first paint that is deliberately inert.
 */
export function readReducedMotion(): boolean {
  if (typeof document === "undefined") return false
  const root = document.documentElement
  if (root.classList.contains(REDUCE_MOTION_CLASS)) return true
  if (root.getAttribute(REDUCE_MOTION_ATTRIBUTE) === "true") return true
  if (root.getAttribute(MOTION_RESPECT_ATTRIBUTE) === "off") return false
  return reducedMotionQuery()?.matches === true
}

// One MutationObserver + one media listener for the whole page, however many
// components are subscribed: a list of animated rows must not mean a list of
// observers on <html>. Started with the first subscriber, torn down with the
// last, so nothing lingers once every consumer has unmounted.
const reducedMotionListeners = new Set<() => void>()
let stopObservingReducedMotion: (() => void) | null = null

function notifyReducedMotionListeners(): void {
  // Snapshot first: a listener may unsubscribe (unmount) while we iterate.
  for (const listener of Array.from(reducedMotionListeners)) listener()
}

function observeReducedMotionSources(onChange: () => void): () => void {
  const cleanups: Array<() => void> = []
  if (typeof document !== "undefined" && typeof MutationObserver === "function") {
    const observer = new MutationObserver(onChange)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: REDUCED_MOTION_ATTRIBUTES,
    })
    cleanups.push(() => observer.disconnect())
  }
  const media = reducedMotionQuery()
  if (media) {
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", onChange)
      cleanups.push(() => media.removeEventListener("change", onChange))
    } else {
      // WebKitGTK builds old enough to ship only the original MediaQueryList API.
      const legacy = media as MediaQueryList & {
        addListener?: (listener: () => void) => void
        removeListener?: (listener: () => void) => void
      }
      legacy.addListener?.(onChange)
      cleanups.push(() => legacy.removeListener?.(onChange))
    }
  }
  return () => {
    for (const cleanup of cleanups) cleanup()
  }
}

/**
 * Subscribe to every source `readReducedMotion` reads: the three `<html>`
 * attributes and the OS media query. Shaped for `useSyncExternalStore`.
 * Returns a disposer.
 */
export function subscribeReducedMotion(onChange: () => void): () => void {
  // A fresh wrapper per call, so two subscriptions of the same function are
  // still counted (and removed) independently.
  const listener = () => onChange()
  reducedMotionListeners.add(listener)
  if (!stopObservingReducedMotion) {
    stopObservingReducedMotion = observeReducedMotionSources(notifyReducedMotionListeners)
  }
  return () => {
    reducedMotionListeners.delete(listener)
    if (reducedMotionListeners.size === 0 && stopObservingReducedMotion) {
      stopObservingReducedMotion()
      stopObservingReducedMotion = null
    }
  }
}

const serverReducedMotion = () => false

/**
 * Whether motion should be suppressed, re-rendering when the user flips the
 * in-app setting or the OS preference changes. Server snapshot: not reduced.
 */
export function useShouldReduceMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, readReducedMotion, serverReducedMotion)
}

/**
 * Returns the supplied variants verbatim, or stripped versions that simply
 * snap to the `animate` state when motion is reduced — by the app's own
 * setting, or by the OS hint unless the user opted out of following it. The
 * helper lets callers write a single variants object and trust the hook to do
 * the right thing under the user's accessibility preference.
 */
export function useReducedMotionVariants(variants: Variants): Variants {
  const reduce = useShouldReduceMotion()
  if (!reduce) return variants
  const target = variants.animate
  return {
    initial: target ?? {},
    animate: target ?? {},
    exit: target ?? {},
  }
}

/**
 * Same idea as `useReducedMotionVariants` but for `Transition` objects.
 * Collapses any transition to `{ duration: 0 }` when reduced motion is on.
 */
export function useReducedMotionTransition(transition: Transition): Transition {
  const reduce = useShouldReduceMotion()
  if (!reduce) return transition
  return { duration: 0 }
}
