/**
 * Web/deep-link carriage for a one-shot cgnp3 pairing invitation.
 *
 * The invitation itself is an opaque `cgnp3|<base64url>` blob (see
 * `pair-payload.ts`). This module owns the one question that blob does not
 * answer: how it rides a URL to the `/pair` screen so the user never has to
 * copy a code by hand.
 *
 * **The fragment is the canonical carrier.** `#payload=…` never leaves the
 * browser: it is not sent to the server, not written to access logs, and not
 * forwarded in a `Referer` header. A one-shot Owner invitation with a five
 * minute TTL is still a bearer secret for those five minutes, so the query
 * form is accepted (the Capacitor deep-link router has always written
 * `?payload=`, and `cognia://` URLs never reach an HTTP server) but never
 * produced by anything that builds a link for a browser.
 */
import { decodePairPayload } from "./pair-payload"

/** Fragment/query key carrying the invitation. */
export const PAIR_LINK_PARAM = "payload"

/**
 * Build the `/pair` URL a desktop Host hands to a browser.
 *
 * @param webOrigin - Origin (or origin + base path) serving the web client.
 * @param payload   - A complete `cgnp3|…` invitation.
 */
export function buildPairLink(webOrigin: string, payload: string): string {
  const base = webOrigin.trim().replace(/\/+$/, "")
  return `${base}/pair#${PAIR_LINK_PARAM}=${encodeURIComponent(payload.trim())}`
}

/**
 * Extract an invitation from a location's query and fragment.
 *
 * Returns the raw string only when it decodes to a currently-valid cgnp3
 * payload: an expired or malformed link must fall through to the manual form
 * rather than auto-submitting something the Host will reject.
 */
export function readPairLinkPayload(search: string, hash: string): string | null {
  for (const raw of [readParam(hash.replace(/^#/, "")), readParam(search.replace(/^\?/, ""))]) {
    if (raw && decodePairPayload(raw).kind === "ok") return raw
  }
  return null
}

function readParam(serialized: string): string | null {
  if (!serialized) return null
  const value = new URLSearchParams(serialized).get(PAIR_LINK_PARAM)
  return value?.trim() ? value.trim() : null
}

/**
 * Drop the invitation from the address bar once it has been consumed.
 *
 * A one-shot invitation is spent by the first successful registration, so
 * leaving it in the URL turns a refresh or a shared link into a confusing
 * "invitation already used" failure — and leaves a live secret in the user's
 * history until it expires. Rewrites in place; never adds a history entry.
 */
export function stripPairLinkPayload(window: Window): void {
  const { location, history } = window
  if (!location.search.includes(PAIR_LINK_PARAM) && !location.hash.includes(PAIR_LINK_PARAM)) {
    return
  }
  const search = new URLSearchParams(location.search.replace(/^\?/, ""))
  search.delete(PAIR_LINK_PARAM)
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""))
  hash.delete(PAIR_LINK_PARAM)
  const query = search.toString()
  const fragment = hash.toString()
  history.replaceState(
    history.state,
    "",
    `${location.pathname}${query ? `?${query}` : ""}${fragment ? `#${fragment}` : ""}`
  )
}
