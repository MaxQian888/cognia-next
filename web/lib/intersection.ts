/**
 * The one place the site constructs an `IntersectionObserver`.
 *
 * Two surfaces watch the viewport — the section-index rail and the stat
 * counters — and each had hand-rolled the same guard-then-construct dance.
 * Only one of them took an injectable factory, so the other's in-view path was
 * untestable: jsdom's `IntersectionObserver` stub never fires, and its suite
 * said as much in a comment instead of covering the behaviour.
 *
 * Injecting the factory is what makes "the element came into view" a thing a
 * test can state, rather than something only a real browser can produce.
 */

export type ObserverFactory = (
  callback: IntersectionObserverCallback,
  options: IntersectionObserverInit
) => IntersectionObserver

/**
 * The factory to use, or `null` where the engine has no `IntersectionObserver`
 * at all (jsdom, older browsers) and the caller must fall back to its
 * non-observed state.
 */
export function resolveObserverFactory(injected?: ObserverFactory): ObserverFactory | null {
  if (injected) return injected
  if (typeof IntersectionObserver === "undefined") return null
  return (callback, options) => new IntersectionObserver(callback, options)
}
