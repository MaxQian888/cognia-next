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
 * The second round, for hosts rather than panes.
 *
 * A pane can only claim a URL once it is mounted, and a workbench panel is not
 * mounted until it has been activated at least once. So the very first link a
 * user clicks in a conversation always found nothing listening and left for
 * the OS browser, which is the opposite of what "open it beside the chat"
 * means. A host that OWNS a browser panel can still serve that click: it
 * reveals the panel and hands the URL to the pane it is about to mount.
 *
 * Kept as a separate round so a visible pane always wins over a reveal. Panes
 * and hosts both listen on `window`, and listener order is registration order,
 * so one shared event would let whichever mounted first answer.
 */
export const BROWSER_REVEAL_URL_EVENT = "cognia:browser:reveal-url"

/**
 * Ask for `url` to be opened in an embedded browser pane. Returns true when a
 * pane took it, or when a host revealed one for it. False means nothing on
 * this surface can show it and the caller should fall back to the OS browser.
 */
export function requestBrowserUrl(url: string): boolean {
  if (typeof window === "undefined") return false
  const detail: BrowserOpenUrlRequest = { url, claimed: false }
  window.dispatchEvent(new CustomEvent(BROWSER_OPEN_URL_EVENT, { detail }))
  if (detail.claimed) return true
  const reveal: BrowserOpenUrlRequest = { url, claimed: false }
  window.dispatchEvent(new CustomEvent(BROWSER_REVEAL_URL_EVENT, { detail: reveal }))
  return reveal.claimed
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
  return subscribe(BROWSER_OPEN_URL_EVENT, handler)
}

/**
 * Subscribe a *host* to the second round: a surface that owns a browser panel
 * and can put it on screen.
 *
 * The handler returns true when it will actually show the URL, which means
 * both halves have to hold. Revealing a panel that then renders an unrelated
 * page is the same lie as claiming while hidden, so a host that cannot pass
 * the address on to the pane it mounts must return false and let the OS
 * browser have it.
 */
export function onBrowserUrlReveal(handler: (url: string) => boolean): () => void {
  return subscribe(BROWSER_REVEAL_URL_EVENT, handler)
}

function subscribe(eventName: string, handler: (url: string) => boolean): () => void {
  if (typeof window === "undefined") return () => {}
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<BrowserOpenUrlRequest>).detail
    if (!detail || typeof detail.url !== "string" || detail.claimed) return
    if (handler(detail.url)) detail.claimed = true
  }
  window.addEventListener(eventName, listener)
  return () => window.removeEventListener(eventName, listener)
}
