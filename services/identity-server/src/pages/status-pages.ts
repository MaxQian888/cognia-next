/**
 * The error page (Better Auth's `onAPIError.errorURL`, and the social
 * `errorCallbackURL`) and the signed-out page.
 */

import { escapeHtml, htmlResponse, newNonce, renderDocument } from "./document"
import { localeFrom, t, type MessageKey } from "./strings"

/** Better Auth / OAuth error codes, folded into the few things a person can act on. */
const ERROR_MESSAGES: Record<string, MessageKey> = {
  account_not_linked: "error.account_not_linked",
  "account not linked": "error.account_not_linked",
  access_denied: "error.access_denied",
  state_mismatch: "error.expired",
  please_restart_the_process: "error.expired",
  invalid_code: "error.expired",
  no_code: "error.expired",
  oauth_provider_not_found: "error.unavailable",
  provider_not_found: "error.unavailable",
}

/** Error codes are echoed for support; anything else is not printed. */
const PRINTABLE_CODE = /^[A-Za-z0-9 _.-]{1,64}$/

export function errorPage(request: Request): Response {
  const url = new URL(request.url)
  const locale = localeFrom(request.headers.get("accept-language"))
  const nonce = newNonce()
  const code = url.searchParams.get("error") ?? ""
  const message = ERROR_MESSAGES[code] ?? "error.generic"
  const codeLine = PRINTABLE_CODE.test(code)
    ? `<p class="code">${escapeHtml(t(locale, "error.code", { code }))}</p>`
    : ""
  const html = renderDocument({
    locale,
    title: t(locale, "error.title"),
    nonce,
    mascot: "worried",
    body: `<h1>${escapeHtml(t(locale, "error.title"))}</h1><p>${escapeHtml(t(locale, message))}</p>${codeLine}<footer>${escapeHtml(t(locale, "error.next"))}</footer>`,
  })
  return htmlResponse(html, nonce, 400)
}

export function signedOutPage(request: Request): Response {
  const locale = localeFrom(request.headers.get("accept-language"))
  const nonce = newNonce()
  const html = renderDocument({
    locale,
    title: t(locale, "signedOut.title"),
    nonce,
    mascot: "farewell",
    body: `<h1>${escapeHtml(t(locale, "signedOut.title"))}</h1><p>${escapeHtml(t(locale, "signedOut.body"))}</p>`,
  })
  return htmlResponse(html, nonce)
}
