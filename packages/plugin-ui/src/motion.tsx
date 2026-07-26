import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
import type { Transition } from "motion/react"

import {
  MOBILE_DURATION,
  MOBILE_EASE,
  STAGGER_CHILD,
  STAGGER_CONTAINER,
  STAGGER_INTERVAL,
  type MobileDurationKey,
} from "./motion-tokens"

/**
 * The animation vocabulary plugins get.
 *
 * `motion` itself is deliberately NOT in the host's shared-module whitelist:
 * handing plugins the raw library would leave every plugin author to reinvent
 * the app's curves, and a plugin bundling its own copy would animate on a
 * second, unsynchronised frame loop. So this is a facade — the same
 * relationship this package already has with `radix-ui` — over the tokens in
 * `./motion-tokens`, which is the very module the host's own surfaces animate
 * from. A plugin panel and the host panel beside it therefore move alike.
 *
 * Reduced motion collapses each wrapper to a plain `<div>` rather than to a
 * zero-duration animation: same DOM shape, same `data-slot`, but no frame loop
 * and no `AnimatePresence` exit to wait on. This mirrors what the host's own
 * `MotionReveal` / `MotionCollapse` primitives do.
 */

/** Public alias — the plugin API shouldn't inherit the token module's legacy `Mobile` prefix. */
export type MotionDurationKey = MobileDurationKey

/**
 * The curve / duration / rhythm values, readable by a plugin that needs to
 * animate something these four components don't cover (a canvas, a CSS
 * transition on its own markup). Seconds, matching motion/react's unit —
 * multiply by 1000 for a CSS `ms` value.
 */
export const motionTokens = {
  /** cubic-bezier control points; iOS-style ease-out. */
  ease: MOBILE_EASE,
  /** Base durations in seconds, before the user's speed multiplier. */
  duration: MOBILE_DURATION,
  /** Gap between consecutive children inside a `<Stagger>`. */
  stagger: { interval: STAGGER_INTERVAL },
} as const

export interface MotionPrefs {
  /**
   * The user's speed setting as a duration multiplier — the same number the
   * host writes to `--motion-duration-scale` and multiplies into the `calc()`
   * of its CSS animations. Above 1 is slower, below 1 is faster.
   */
  durationScale: number
  /** True when animation must be suppressed entirely. */
  reduced: boolean
}

/** Class the host puts on `<html>` when animation should be suppressed. */
const REDUCE_MOTION_CLASS = "reduce-motion"

const DEFAULT_PREFS: MotionPrefs = { durationScale: 1, reduced: false }

/**
 * Probe the OS-level hint. Wrapped in try/catch because jsdom and some
 * embedded webviews implement `matchMedia` only partially — a throwing probe
 * must degrade to "animate", never crash inside a plugin's render.
 */
function reducedMotionQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)")
  } catch {
    return null
  }
}

/**
 * Two independent sources, and missing either one is a real accessibility bug:
 * the in-app toggle writes the `reduce-motion` class on `<html>`, while the
 * OS-level `prefers-reduced-motion` is handled purely by a media query in the
 * host's stylesheet and is never mirrored into the DOM. This is the same pair
 * `lib/plugin/api/theme-tokens.ts` checks for the `ThemeState` it hands
 * plugins; re-derived here because this package may not import from the app.
 */
function isReduced(): boolean {
  if (typeof document === "undefined") return false
  if (document.documentElement.classList.contains(REDUCE_MOTION_CLASS)) return true
  return reducedMotionQuery()?.matches === true
}

// `useSyncExternalStore` re-renders whenever `getSnapshot` returns a value that
// isn't `Object.is`-equal to the previous one, so handing back a fresh object
// per read would spin forever. Cache the last snapshot and swap it only when a
// field actually moved.
let cachedPrefs: MotionPrefs = DEFAULT_PREFS

function readPrefs(): MotionPrefs {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") {
    return DEFAULT_PREFS
  }
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--motion-duration-scale")
  const parsed = Number.parseFloat(raw)
  const durationScale = Number.isFinite(parsed) && parsed >= 0 ? parsed : 1
  const reduced = isReduced()
  if (durationScale === cachedPrefs.durationScale && reduced === cachedPrefs.reduced) {
    return cachedPrefs
  }
  cachedPrefs = { durationScale, reduced }
  return cachedPrefs
}

/**
 * Both preference sources are DOM state the host rewrites at runtime (the
 * settings applier toggles the class and the custom property on `<html>`), so
 * a one-shot read would leave every mounted plugin animating at whatever the
 * setting happened to be when it mounted.
 */
function subscribePrefs(onChange: () => void): () => void {
  const cleanups: Array<() => void> = []
  if (typeof document !== "undefined" && typeof MutationObserver === "function") {
    const observer = new MutationObserver(onChange)
    // `class` carries the reduce toggle; `style` carries the duration scale,
    // which the applier writes as an inline custom property on <html>.
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    })
    cleanups.push(() => observer.disconnect())
  }
  const media = reducedMotionQuery()
  if (media && typeof media.addEventListener === "function") {
    media.addEventListener("change", onChange)
    cleanups.push(() => media.removeEventListener("change", onChange))
  }
  return () => {
    for (const cleanup of cleanups) cleanup()
  }
}

/**
 * The user's current motion preferences. Use it to gate a plugin's own
 * animations — the four components below already respect it.
 */
export function useMotionPrefs(): MotionPrefs {
  return React.useSyncExternalStore(subscribePrefs, readPrefs, () => DEFAULT_PREFS)
}

function transitionFor(duration: MotionDurationKey, durationScale: number): Transition {
  return { duration: MOBILE_DURATION[duration] * durationScale, ease: MOBILE_EASE }
}

/**
 * DOM props forwarded verbatim to the rendered element. The handlers
 * `motion.div` redefines for its own gesture/animation system are dropped:
 * keeping them would make the same props object illegal on the plain `<div>`
 * the reduced-motion branch renders.
 */
type PassthroughProps = Omit<
  React.ComponentProps<"div">,
  "children" | "onDrag" | "onDragStart" | "onDragEnd" | "onAnimationStart"
>

interface AnimatedProps extends PassthroughProps {
  children?: React.ReactNode
  /** Which token duration to run at. Defaults to `normal` (280 ms). */
  duration?: MotionDurationKey
}

export interface FadeProps extends AnimatedProps {
  /** Whether the content is present. Toggling it plays the fade in / out. */
  show?: boolean
}

/**
 * Fade content in and out. `show` defaults to true so a plugin that only wants
 * a mount animation can wrap without wiring state — and so content is never
 * accidentally invisible.
 */
function Fade({ show = true, duration = "normal", children, ...props }: FadeProps) {
  const { durationScale, reduced } = useMotionPrefs()

  if (reduced) {
    return show ? (
      <div data-slot="fade" {...props}>
        {children}
      </div>
    ) : null
  }

  return (
    <AnimatePresence>
      {show ? (
        <motion.div
          key="fade"
          data-slot="fade"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={transitionFor(duration, durationScale)}
          {...props}
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}

export interface SlideUpProps extends AnimatedProps {
  /** Whether the content is present. Toggling it plays the slide in / out. */
  show?: boolean
}

/**
 * Fade + rise. The 8px offset comes from `STAGGER_CHILD`, so a standalone
 * `SlideUp` and a row inside a `Stagger` travel the same distance — mixing the
 * two in one panel doesn't read as two different animations.
 */
function SlideUp({ show = true, duration = "normal", children, ...props }: SlideUpProps) {
  const { durationScale, reduced } = useMotionPrefs()

  if (reduced) {
    return show ? (
      <div data-slot="slide-up" {...props}>
        {children}
      </div>
    ) : null
  }

  return (
    <AnimatePresence>
      {show ? (
        <motion.div
          key="slide-up"
          data-slot="slide-up"
          variants={STAGGER_CHILD}
          initial="initial"
          animate="animate"
          exit="exit"
          transition={transitionFor(duration, durationScale)}
          {...props}
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}

export type StaggerProps = AnimatedProps

/**
 * Reveal children one after another. Each child gets a wrapper, and the wrapper
 * survives into the reduced-motion branch — dropping it would change the DOM
 * shape, and therefore the flex/grid layout, based on an accessibility setting.
 *
 * The stagger interval is *not* scaled by `durationScale`: it is a rhythm
 * between elements rather than the length of any one animation, and the host's
 * own staggered lists use `STAGGER_CONTAINER` unscaled.
 */
function Stagger({ duration = "normal", children, ...props }: StaggerProps) {
  const { durationScale, reduced } = useMotionPrefs()

  if (reduced) {
    return (
      <div data-slot="stagger" {...props}>
        {React.Children.map(children, (child) => (
          <div data-slot="stagger-item">{child}</div>
        ))}
      </div>
    )
  }

  return (
    <motion.div
      data-slot="stagger"
      variants={STAGGER_CONTAINER}
      initial="initial"
      animate="animate"
      {...props}
    >
      {React.Children.map(children, (child) => (
        <motion.div
          data-slot="stagger-item"
          variants={STAGGER_CHILD}
          transition={transitionFor(duration, durationScale)}
        >
          {child}
        </motion.div>
      ))}
    </motion.div>
  )
}

export interface CollapseProps extends AnimatedProps {
  /** Whether the body is expanded. Toggling it animates the height. */
  show?: boolean
}

/**
 * Expand / collapse a region by animating its height.
 *
 * `overflow: hidden` is an inline style rather than a utility class so the
 * clipping cannot be dropped by a Tailwind purge in a plugin's own build. The
 * token ease being monotonic matters here: a spring overshoots `auto` and,
 * under the clip, shears the last rows of content off for a frame.
 */
function Collapse({ show = true, duration = "normal", children, style, ...props }: CollapseProps) {
  const { durationScale, reduced } = useMotionPrefs()

  if (reduced) {
    return show ? (
      <div data-slot="collapse" style={style} {...props}>
        {children}
      </div>
    ) : null
  }

  return (
    <AnimatePresence initial={false}>
      {show ? (
        <motion.div
          key="collapse"
          data-slot="collapse"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={transitionFor(duration, durationScale)}
          style={{ overflow: "hidden", ...style }}
          {...props}
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}

export { Collapse, Fade, SlideUp, Stagger }
