/**
 * "Open this URL in the side browser, if there is one."
 *
 * ⌘-clicking a link in the composer should land in the embedded browser pane
 * rather than throwing the user out to Safari — but that pane only exists on
 * surfaces that have the dock open, and the composer has no business knowing
 * which those are. So the request is broadcast, and whoever can serve it CLAIMS
 * it synchronously; an unclaimed request falls back to the OS browser.
 *
 * A DOM event on `window` for the same reason as
 * `lib/shell/command-palette-request.ts`: no store, and no import edge between
 * the composer and the browser subsystem.
 */

export const BROWSER_OPEN_URL_EVENT = "cognia:browser:open-url"

export interface BrowserOpenUrlRequest {
  url: string
  /**
   * Set by a listener that actually opened it. Read back by the caller right
   * after `dispatchEvent` returns — event dispatch is synchronous, so this is a
   * reliable "did anyone take it?" answer without timers or a return channel.
   */
  claimed: boolean
}

/**
 * Ask for `url` to be opened in an embedded browser pane. Returns true when a
 * pane took it; false means nothing is listening and the caller should fall
 * back (the OS browser).
 */
export function requestBrowserUrl(url: string): boolean {
  if (typeof window === "undefined") return false
  const detail: BrowserOpenUrlRequest = { url, claimed: false }
  window.dispatchEvent(new CustomEvent(BROWSER_OPEN_URL_EVENT, { detail }))
  return detail.claimed
}

/**
 * Subscribe a pane. The handler returns true when it opened the URL; returning
 * false leaves the request unclaimed for the caller's fallback.
 *
 * Being mounted is NOT sufficient grounds to claim: a dock panel with
 * `retention: "stateful"` stays mounted behind whichever tab is showing, and a
 * pane that navigates out of sight looks to the user exactly like the link
 * doing nothing. Claim only when the user will see the result — either the
 * pane is already visible, or it just revealed itself.
 */
export function onBrowserUrlRequest(handler: (url: string) => boolean): () => void {
  if (typeof window === "undefined") return () => {}
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<BrowserOpenUrlRequest>).detail
    if (!detail || typeof detail.url !== "string" || detail.claimed) return
    if (handler(detail.url)) detail.claimed = true
  }
  window.addEventListener(BROWSER_OPEN_URL_EVENT, listener)
  return () => window.removeEventListener(BROWSER_OPEN_URL_EVENT, listener)
}
