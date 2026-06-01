/**
 * URL helpers for exact-match dedup. Local re-implementation (no `@/lib/*`).
 */

/**
 * Canonicalise a URL for dedup: lowercase host+path, drop the fragment and
 * common tracking params, strip a trailing slash. Returns the input lowercased
 * when it isn't a parseable URL.
 */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.hash = ""
    for (const key of [...parsed.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_") || key === "ref" || key === "fbclid") {
        parsed.searchParams.delete(key)
      }
    }
    return parsed.toString().replace(/\/$/, "").toLowerCase()
  } catch {
    return url.trim().toLowerCase()
  }
}

/** True when both URLs canonicalise to the same value. */
export function sameUrl(a: string, b: string): boolean {
  return normalizeUrl(a) === normalizeUrl(b)
}
