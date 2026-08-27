/**
 * Decide what of a page's address may be sent.
 *
 * A URL looks like metadata and routinely is not. Query strings carry session
 * tokens, single-use reset links, tracking ids and — on a search results page —
 * the thing the person was looking for. Fragments carry document positions and,
 * on some apps, the entire route. None of that is implied by "send me this
 * page", so the default strips them and the user can put them back per capture.
 *
 * Credentials are stripped unconditionally: `https://user:pw@host/` is a
 * password in a field labelled "address", and there is no capture for which
 * including it is the right answer.
 */

export type UrlDecision =
  | { ok: true; url: string; strippedQuery: boolean; strippedFragment: boolean }
  | { ok: false; reason: "unsupported-scheme" | "unparseable" }

export function normalizeCaptureUrl(raw: string, includeFullUrl = false): UrlDecision {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: "unparseable" }
  }
  // Only ordinary web pages. `chrome://`, `file://`, `data:`, `about:` and the
  // extension's own pages are all things the user did not mean by "this page",
  // and several of them are local filesystem or browser-internal state.
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "unsupported-scheme" }
  }
  const strippedQuery = url.search !== "" && !includeFullUrl
  const strippedFragment = url.hash !== "" && !includeFullUrl
  url.username = ""
  url.password = ""
  if (!includeFullUrl) {
    url.search = ""
    url.hash = ""
  }
  return { ok: true, url: url.toString(), strippedQuery, strippedFragment }
}

/** Whether a tab can be captured at all, without parsing further. */
export function isCapturableUrl(raw: string): boolean {
  return normalizeCaptureUrl(raw).ok
}
