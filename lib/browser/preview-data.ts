/**
 * What the built-in browser keeps outside the account database, and the one
 * place that removes it.
 *
 * The visit history and recorded flows are Dexie tables and go with the
 * database. Three small preferences live in `localStorage`, and the preview's
 * cookies live in the webview's own store — including any sign-in imported
 * from a Chromium profile (ADR-0073). "Clear all data" dropped the database
 * and left both behind, so a reset device stayed signed in to whatever the
 * preview had visited.
 */

import { clearAllSiteCookies } from "@/lib/browser/cookie-import"
import { isTauri } from "@/lib/tauri"

/** The zoom level the embedded preview re-applies on every page. */
export const BROWSER_ZOOM_STORAGE_KEY = "cognia.browser.zoom"
/** The annotation detail level for comments and screenshots sent to chat. */
export const BROWSER_DETAIL_STORAGE_KEY = "cognia.browser.output-detail"
/** The user accepted reading local Chromium cookies (ADR-0073). */
export const COOKIE_IMPORT_CONSENT_STORAGE_KEY = "cognia.browser.cookie-import-consent.v1"

export const BROWSER_PREVIEW_STORAGE_KEYS = [
  BROWSER_ZOOM_STORAGE_KEY,
  BROWSER_DETAIL_STORAGE_KEY,
  COOKIE_IMPORT_CONSENT_STORAGE_KEY,
] as const

export interface BrowserPreviewDataCleared {
  /** Public-site cookies removed from the preview; 0 off the desktop. */
  cookiesRemoved: number
}

/**
 * Forget the browser's preferences and sign the preview out of every public
 * site. Off the desktop there is no native preview and no cookie store of ours
 * to clear, so only the preferences go.
 */
export async function clearBrowserPreviewData(): Promise<BrowserPreviewDataCleared> {
  for (const key of BROWSER_PREVIEW_STORAGE_KEYS) {
    try {
      window.localStorage.removeItem(key)
    } catch {
      // Storage disabled or unavailable: there is nothing of ours in it.
    }
  }
  if (!isTauri()) return { cookiesRemoved: 0 }
  const { removed } = await clearAllSiteCookies()
  return { cookiesRemoved: removed }
}
