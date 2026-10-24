/**
 * URL policy for A2UI surfaces (ADR-0240).
 *
 * A surface is written by a model (or an external agent over MCP, or an IM
 * card), so its URLs are untrusted the same way third-party chat Markdown is:
 * the policy mirrors `untrustedMarkdownUrlTransform`
 * (`components/chat/markdown/rendering-policy.ts`), and a test pins the two
 * together. A rejected URL is not rewritten, it is dropped; the component then
 * renders its text (or its action button) without a navigation target.
 *
 * Links: `http:`, `https:`, `mailto:`. No `javascript:`, `file:`, `data:`,
 * custom schemes, or relative targets, which the desktop shell would resolve
 * against the app itself.
 *
 * Media: `http:`, `https:`, `data:image/…`, plus `blob:` and root-relative
 * paths, which can only point at the app's own object URLs and bundled
 * assets.
 */

function schemeOf(url: string): string | null {
  // Control characters and whitespace inside a scheme are a classic way to
  // smuggle `java\tscript:` past a naive prefix check; the URL parser strips
  // them, so a rejected-looking scheme cannot become an accepted one here.
  const colon = url.indexOf(":")
  if (colon === -1) return null
  const scheme = url
    .slice(0, colon)
    .replace(/[\x00-\x20\x7f]/g, "")
    .toLowerCase()
  return /^[a-z][a-z0-9+.-]*$/.test(scheme) ? scheme : ""
}

/**
 * A navigable `href`, or null when the target must not be followed. A web URL
 * comes back in the URL parser's canonical form: browsers also accept
 * `https:evil.com`, `https:\\evil.com` or a leading control character, and
 * only the canonical `https://…` form is recognised (and kept out of the app
 * window) by `ExternalLink`.
 */
export function safeA2UIHref(value: unknown): string | null {
  if (typeof value !== "string") return null
  const url = value.trim()
  if (!url) return null
  const scheme = schemeOf(url)
  if (scheme === "http" || scheme === "https") return canonicalWebUrl(url)
  if (scheme === "mailto") return url
  return null
}

/**
 * The target an action may carry for a model-written `href`: a navigable
 * `href`, or a scheme-less in-surface route (`/settings`, `#step-2`, `next`)
 * the action's handler interprets itself. A rejected scheme (`javascript:`,
 * `file:`, …) is dropped, so handlers and plugins never receive one.
 */
export function a2uiActionTarget(value: unknown): string | null {
  if (typeof value !== "string") return null
  const url = value.trim()
  if (!url) return null
  return schemeOf(url) === null ? url : safeA2UIHref(url)
}

/** True when `href` (already accepted by `safeA2UIHref`) opens a web page. */
export function isWebHref(href: string): boolean {
  const scheme = schemeOf(href)
  return scheme === "http" || scheme === "https"
}

/** An image/media `src`, or null when it must not be loaded. */
export function safeA2UIMediaSrc(value: unknown): string | null {
  if (typeof value !== "string") return null
  const url = value.trim()
  if (!url) return null
  if (/^data:image\//i.test(url)) return url
  if (url.startsWith("/") && !url.startsWith("//") && !url.startsWith("/\\")) return url
  const scheme = schemeOf(url)
  if (scheme === "http" || scheme === "https") return canonicalWebUrl(url)
  if (scheme === "blob") return url
  return null
}

function canonicalWebUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null
  } catch {
    return null
  }
}

// CSS functions that fetch a resource. `url()` targets go through the media
// policy; `image-set()` and `src()` accept bare strings as URLs, so they are
// refused outright rather than parsed.
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi
const CSS_UNPARSED_FETCH = /(?:image-set|src)\s*\(/i
/** Legacy script-bearing properties some engines still honour. */
const CSS_SCRIPT_PROPERTIES = new Set(["behavior", "-moz-binding", "MozBinding", "mozBinding"])

/**
 * A model-written inline `style` with every property that would load a URL
 * the media policy rejects removed. A value containing a CSS escape is dropped
 * too, since an escape can spell `url(` past any pattern, and so is any value
 * that is not a string or finite number. Returns undefined for anything that
 * is not a plain style object.
 */
export function safeA2UIStyle(value: unknown): Record<string, string | number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const safe: Record<string, string | number> = {}
  for (const [property, raw] of Object.entries(value as Record<string, unknown>)) {
    if (CSS_SCRIPT_PROPERTIES.has(property)) continue
    // A style value is a string or a number; anything else is not CSS.
    if (typeof raw === "number" && Number.isFinite(raw)) safe[property] = raw
    else if (typeof raw === "string" && isSafeCssValue(raw)) safe[property] = raw
  }
  return safe
}

function isSafeCssValue(value: string): boolean {
  if (value.includes("\\") || /expression\s*\(/i.test(value) || CSS_UNPARSED_FETCH.test(value)) {
    return false
  }
  const matches = [...value.matchAll(CSS_URL)]
  // CSS still reads an unclosed `url(` at the end of a value as a URL, so
  // every opening must be one the pattern above checked.
  if (matches.length !== (value.match(/url\(/gi)?.length ?? 0)) return false
  return matches.every((match) => safeA2UIMediaSrc(match[1] ?? match[2] ?? match[3] ?? "") !== null)
}
