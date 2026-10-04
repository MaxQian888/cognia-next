/**
 * The page a browser shows while handing a sign-in back to the native app.
 *
 * The desktop and phone clients redirect to `cn.cognia.app:/auth/callback`.
 * A navigation to a custom scheme never commits: the tab stays on whatever
 * page it was on (the provider's authorization page), and if the person
 * dismisses the browser's "Open Cognia?" prompt nothing on screen says what
 * happened or how to get back. So a redirect to the app is answered with this
 * page instead: it says the sign-in finished (or did not), opens the app on
 * its own, and keeps an "Open Cognia" link for a dismissed prompt.
 *
 * The authorization code travels exactly as far as before: the redirect
 * target, now in a link and a JSON block on a no-store, no-referrer page
 * instead of a `Location` header.
 */

import { NATIVE_CALLBACK_URI } from "../first-party-clients"
import { GO_ICON, escapeHtml, htmlResponse, newNonce, renderDocument } from "./document"
import { localeFrom, t } from "./strings"

const SCRIPT = `
const { target } = JSON.parse(document.getElementById("page-data").textContent)
window.location.replace(target)
`

/** A top-level page load in a browser, as opposed to an API call. */
export function isBrowserNavigation(request: Request): boolean {
  const mode = request.headers.get("sec-fetch-mode")
  if (mode) return mode === "navigate"
  return (request.headers.get("accept") ?? "").includes("text/html")
}

/** Whether a redirect target is the native app's callback. */
export function isNativeAppRedirect(location: string | null): location is string {
  return !!location && location.startsWith(`${NATIVE_CALLBACK_URI}?`)
}

export function returnToAppPage(request: Request, target: string): Response {
  const locale = localeFrom(request.headers.get("accept-language"))
  const nonce = newNonce()
  const failed = new URL(target).searchParams.has("error")
  const title = t(locale, failed ? "return.failedTitle" : "return.title")
  const html = renderDocument({
    locale,
    title,
    nonce,
    mascot: failed ? "worried" : "happy",
    body:
      `<h1>${escapeHtml(title)}</h1>` +
      `<p>${escapeHtml(t(locale, failed ? "return.failedBody" : "return.body"))}</p>` +
      `<div class="actions"><a class="button primary" href="${escapeHtml(target)}">${escapeHtml(t(locale, "return.open"))}${GO_ICON}</a></div>` +
      `<footer>${escapeHtml(t(locale, "return.hint"))}</footer>`,
    data: { target },
    script: SCRIPT,
  })
  return htmlResponse(html, nonce)
}
