/**
 * The one answer to "should this animate?".
 *
 * There are TWO independent sources of that preference in this app and, until
 * this module, no caller consulted both:
 *
 *   - the OS hint, `prefers-reduced-motion: reduce`, which `globals.css`
 *     already honours for CSS-declared animation but which JS-driven motion
 *     never saw, and
 *   - the app's own `MotionSettings.reduce` toggle, which puts a `reduce-motion`
 *     class on `<html>` and is an explicit user opt-in that must win even on a
 *     machine whose OS says nothing.
 *
 * A feature that checks only the media query ignores the app's own switch. A
 * feature that checks only the setting ignores the accessibility preference
 * the user already expressed to their operating system. Both are wrong, and
 * both are easy to write by accident, so the composition lives here.
 */

/** The media query both the CSS and this module key off. */
export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)"

/** The class `motion-applier` puts on `<html>` for an explicit opt-in. */
export const REDUCE_MOTION_CLASS = "reduce-motion"

/**
 * Whether motion should be suppressed right now.
 *
 * Returns `false` outside a browser, which is the honest answer during a
 * static export: there is no user and no preference, and defaulting to "reduce"
 * would ship a build whose first paint is deliberately inert.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return false
  if (document.documentElement.classList.contains(REDUCE_MOTION_CLASS)) return true
  // `matchMedia` is absent in some test environments and in older WebViews.
  // Treating its absence as "no preference" matches the CSS fallback.
  if (typeof window.matchMedia !== "function") return false
  try {
    return window.matchMedia(REDUCED_MOTION_QUERY).matches
  } catch {
    return false
  }
}

/**
 * Subscribe to changes in the OS hint.
 *
 * The app's own class is NOT observed here: it changes only through the
 * settings store, whose subscribers already re-render. Returns a disposer, and
 * a no-op disposer where the API is unavailable, so callers never have to
 * null-check the return.
 */
export function subscribeReducedMotion(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {}
  }
  let query: MediaQueryList
  try {
    query = window.matchMedia(REDUCED_MOTION_QUERY)
  } catch {
    return () => {}
  }
  const handler = () => onChange()
  // `addEventListener` on a MediaQueryList is the modern form. The deprecated
  // `addListener` is kept as a fallback for WebKitGTK builds old enough to
  // ship the original API only.
  if (typeof query.addEventListener === "function") {
    query.addEventListener("change", handler)
    return () => query.removeEventListener("change", handler)
  }
  const legacy = query as MediaQueryList & {
    addListener?: (fn: () => void) => void
    removeListener?: (fn: () => void) => void
  }
  legacy.addListener?.(handler)
  return () => legacy.removeListener?.(handler)
}
