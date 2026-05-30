// PROPFIND multistatus parsing. Servers vary wildly in namespace prefixes
// (`D:`, `d:`, default ns) and date formats, so we traverse namespace-
// agnostically via `getElementsByTagNameNS("*", …)` and parse dates leniently.
//
// DOMParser is available in every WebView (Tauri + Capacitor) and in the
// jsdom test environment, so no XML dependency is needed.

import type { WebDavEntry } from "./types"

function firstLocalChildText(el: Element, localName: string): string | undefined {
  const nodes = el.getElementsByTagNameNS("*", localName)
  const text = nodes.item(0)?.textContent
  return text == null ? undefined : text.trim()
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "")
}

function basename(path: string): string {
  const trimmed = stripTrailingSlash(path)
  const idx = trimmed.lastIndexOf("/")
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed
}

function decodeHref(href: string): string {
  try {
    return decodeURIComponent(href)
  } catch {
    // Malformed percent-encoding — keep the raw href rather than throwing.
    return href
  }
}

/**
 * Parse a `<multistatus>` document into entries. Responses without an `<href>`
 * are skipped. The collection itself (Depth:1 returns it as the first entry)
 * is included; callers filter by name/suffix as needed.
 */
export function parseMultiStatus(xml: string): WebDavEntry[] {
  const doc = new DOMParser().parseFromString(xml, "application/xml")
  // A parse error surfaces as a <parsererror> element in most engines.
  if (doc.getElementsByTagName("parsererror").length > 0) {
    return []
  }

  const responses = doc.getElementsByTagNameNS("*", "response")
  const entries: WebDavEntry[] = []

  for (let i = 0; i < responses.length; i++) {
    const response = responses.item(i)
    if (!response) continue

    const rawHref = firstLocalChildText(response, "href")
    if (!rawHref) continue
    const href = decodeHref(rawHref)

    const isCollection = response.getElementsByTagNameNS("*", "collection").length > 0

    const lengthText = firstLocalChildText(response, "getcontentlength")
    const size = lengthText && /^\d+$/.test(lengthText) ? Number(lengthText) : undefined

    const modifiedText = firstLocalChildText(response, "getlastmodified")
    const parsedMs = modifiedText ? Date.parse(modifiedText) : NaN
    const lastModified = Number.isNaN(parsedMs) ? undefined : parsedMs

    const etagRaw = firstLocalChildText(response, "getetag")
    const etag = etagRaw ? etagRaw.replace(/^"|"$/g, "") : undefined

    entries.push({
      href,
      name: basename(href),
      isCollection,
      size,
      lastModified,
      etag,
    })
  }

  return entries
}
