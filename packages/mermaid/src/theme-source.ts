/**
 * One shared watcher for the Mermaid theme, derived from the global `.dark`
 * class on `<html>`.
 *
 * Every `<MermaidBlock>` used to mount its own `MutationObserver` on
 * `document.documentElement`. With a session full of diagrams that is one
 * observer per diagram, all firing on *every* attribute change to `<html>` —
 * not just theme toggles — and each callback re-entering the render path. This
 * module keeps a single observer alive for as long as anyone is subscribed and
 * fans the result out, so the cost is O(1) in the number of diagrams.
 *
 * Also the one place that decides what "the theme" is, so the render cache key
 * and the component that reads it cannot drift apart.
 */

export type MermaidTheme = "dark" | "default"

type Listener = (theme: MermaidTheme) => void

const listeners = new Set<Listener>()
let observer: MutationObserver | null = null
let lastTheme: MermaidTheme | null = null

/** Resolve the active theme. Returns `"default"` outside a browser. */
export function readMermaidTheme(): MermaidTheme {
  if (typeof document === "undefined") return "default"
  return document.documentElement.classList.contains("dark") ? "dark" : "default"
}

function notify(): void {
  const theme = readMermaidTheme()
  // The observer fires for any attribute change on <html>; only a real theme
  // flip is worth waking every diagram in the transcript.
  if (theme === lastTheme) return
  lastTheme = theme
  for (const listener of listeners) listener(theme)
}

/**
 * Subscribe to theme flips. Returns an unsubscribe function; the underlying
 * observer is created on the first subscriber and disconnected after the last
 * one leaves.
 */
export function subscribeMermaidTheme(listener: Listener): () => void {
  listeners.add(listener)
  if (observer === null && typeof MutationObserver !== "undefined") {
    lastTheme = readMermaidTheme()
    observer = new MutationObserver(notify)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    })
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      observer?.disconnect()
      observer = null
      lastTheme = null
    }
  }
}

/** Test-only: drop the observer and every subscriber. */
export function resetMermaidThemeWatch(): void {
  listeners.clear()
  observer?.disconnect()
  observer = null
  lastTheme = null
}
