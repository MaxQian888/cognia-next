/**
 * The record the background worker leaves for the side panel.
 *
 * It exists because the two are not alive at the same time. A context-menu
 * click happens in the worker; the panel it opens may be starting from nothing.
 * Passing a message would need a listener that is not there yet, so the worker
 * writes a request and the panel reads it on mount.
 *
 * What crosses is a tab id and a mode — never page content. The panel does the
 * extraction itself, because `activeTab` is granted to the gesture that opened
 * it and because the user reviews the result before anything is sent.
 */

/** `chrome.storage.local` key holding the pending request. */
export const CAPTURE_REQUEST_KEY = "cognia.captureRequest.v1"

export const CAPTURE_MENU_IDS = {
  selection: "cognia-capture-selection",
  page: "cognia-capture-page",
} as const

/**
 * `auto` means "take the selection if there is one, otherwise the metadata" —
 * the toolbar and shortcut path, where the user has not said which they want.
 */
export type CaptureRequestMode = "auto" | "selection" | "page"

export interface CaptureRequest {
  tabId: number
  mode: CaptureRequestMode
  requestedAt: number
}

/** Whether a menu entry should be offered for a tab at all. */
export function shouldOfferCaptureMenu(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://")
}

/** Turn a clicked menu id into a request, or `null` if it is not one of ours. */
export function captureRequestForMenu(
  menuItemId: string,
  tabId: number,
  requestedAt: number
): CaptureRequest | null {
  if (menuItemId === CAPTURE_MENU_IDS.selection) {
    return { tabId, mode: "selection", requestedAt }
  }
  if (menuItemId === CAPTURE_MENU_IDS.page) return { tabId, mode: "page", requestedAt }
  return null
}

/**
 * Whether a stored request is recent enough to act on.
 *
 * A request older than this is one the browser held while the panel was shut,
 * possibly across a restart. Acting on it would capture whatever tab now has
 * that id, which is not what the user asked for and may not even be the same
 * page.
 */
export const CAPTURE_REQUEST_TTL_MS = 60_000

export function isFreshCaptureRequest(request: CaptureRequest, now: number): boolean {
  return now - request.requestedAt < CAPTURE_REQUEST_TTL_MS && now >= request.requestedAt
}
