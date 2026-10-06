/**
 * Read a link preview out of an HTML document head (ADR-0218).
 *
 * Uses the WebView's own `DOMParser` rather than `packages/document`'s cheerio
 * parser: a preview runs on hover, cheerio is a large lazy chunk to pull in for
 * a dozen meta tags, and that parser reads neither icon links nor
 * `og:site_name`. The parser never executes scripts or loads subresources, so
 * parsing an untrusted page here is inert.
 *
 * Pure apart from `DOMParser`; every URL it returns is absolute and http(s)
 * (or a `data:image/…` favicon, which some sites inline).
 */

export interface ParsedLinkMetadata {
  title?: string
  description?: string
  siteName?: string
  imageUrl?: string
  imageAlt?: string
  faviconUrl?: string
  themeColor?: string
}

/** Longest title / description kept; a card clamps visually well below this. */
export const MAX_TITLE_LENGTH = 200
export const MAX_DESCRIPTION_LENGTH = 400

/**
 * Only the head matters, and a long article body is most of the parse cost.
 * Cut at the first `</head>` when there is one.
 */
export function sliceDocumentHead(html: string): string {
  const end = html.search(/<\/head\s*>/i)
  return end === -1 ? html : html.slice(0, end) + "</head><body></body>"
}

function clean(value: string | null | undefined, max: number): string | undefined {
  if (!value) return undefined
  const collapsed = value.replace(/\s+/g, " ").trim()
  if (!collapsed) return undefined
  return collapsed.length > max ? `${collapsed.slice(0, max - 1).trimEnd()}…` : collapsed
}

function absoluteHttpUrl(value: string | null | undefined, base: string): string | undefined {
  if (!value) return undefined
  try {
    const resolved = new URL(value.trim(), base)
    return resolved.protocol === "http:" || resolved.protocol === "https:"
      ? resolved.href
      : undefined
  } catch {
    return undefined
  }
}

function metaContent(doc: Document, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    // Open Graph uses `property`, Twitter and plain meta use `name`; sites mix
    // them up often enough that both attributes are checked for every key.
    const element =
      doc.querySelector(`meta[property="${key}" i]`) ?? doc.querySelector(`meta[name="${key}" i]`)
    const content = element?.getAttribute("content")
    if (content && content.trim()) return content
  }
  return undefined
}

/** Largest declared edge of a `sizes` attribute (`"32x32 64x64"` → 64), 0 when absent. */
function iconSize(sizes: string | null): number {
  if (!sizes) return 0
  if (/any/i.test(sizes)) return 512
  return sizes
    .split(/\s+/)
    .map((pair) => Number.parseInt(pair.split(/x/i)[0] ?? "", 10))
    .filter(Number.isFinite)
    .reduce((max, size) => Math.max(max, size), 0)
}

/**
 * Pick the icon that renders best at 16–20px: a declared icon nearest 32px,
 * preferring SVG, then an apple-touch-icon, then `/favicon.ico`.
 */
function pickFavicon(doc: Document, base: string): string | undefined {
  const candidates = Array.from(doc.querySelectorAll("link[rel][href]"))
    .map((link) => ({
      rel: (link.getAttribute("rel") ?? "").toLowerCase().split(/\s+/),
      href: link.getAttribute("href") ?? "",
      type: (link.getAttribute("type") ?? "").toLowerCase(),
      size: iconSize(link.getAttribute("sizes")),
    }))
    .filter((link) => link.rel.includes("icon") || link.rel.includes("apple-touch-icon"))

  const resolve = (href: string) => {
    if (/^data:image\//i.test(href.trim())) return href.trim()
    return absoluteHttpUrl(href, base)
  }

  const icons = candidates.filter((link) => link.rel.includes("icon"))
  const svg = icons.find(
    (link) => link.type === "image/svg+xml" || /\.svg(?:[?#]|$)/i.test(link.href)
  )
  if (svg) {
    const url = resolve(svg.href)
    if (url) return url
  }
  const sized = [...icons].sort((a, b) => {
    // Distance from the 32px sweet spot; an undeclared size counts as 16px.
    const distance = (size: number) => Math.abs((size || 16) - 32)
    return distance(a.size) - distance(b.size)
  })
  for (const icon of sized) {
    const url = resolve(icon.href)
    if (url) return url
  }
  const touch = candidates.find((link) => link.rel.includes("apple-touch-icon"))
  if (touch) {
    const url = resolve(touch.href)
    if (url) return url
  }
  return absoluteHttpUrl("/favicon.ico", base)
}

/**
 * Extract preview metadata from `html` fetched from `pageUrl` (the final URL
 * after redirects, so relative references resolve where the browser would).
 */
export function parseLinkMetadata(html: string, pageUrl: string): ParsedLinkMetadata {
  const doc = new DOMParser().parseFromString(sliceDocumentHead(html), "text/html")
  const baseHref = doc.querySelector("base[href]")?.getAttribute("href")
  const base = absoluteHttpUrl(baseHref, pageUrl) ?? pageUrl

  const title = clean(
    metaContent(doc, ["og:title", "twitter:title"]) ?? doc.querySelector("title")?.textContent,
    MAX_TITLE_LENGTH
  )
  const description = clean(
    metaContent(doc, ["og:description", "twitter:description", "description"]),
    MAX_DESCRIPTION_LENGTH
  )
  const siteName = clean(metaContent(doc, ["og:site_name", "application-name"]), 80)
  const imageUrl = absoluteHttpUrl(
    metaContent(doc, [
      "og:image:secure_url",
      "og:image:url",
      "og:image",
      "twitter:image",
      "twitter:image:src",
    ]),
    base
  )
  const imageAlt = clean(metaContent(doc, ["og:image:alt", "twitter:image:alt"]), 200)
  const themeColor = clean(metaContent(doc, ["theme-color"]), 40)

  return {
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(siteName ? { siteName } : {}),
    ...(imageUrl ? { imageUrl } : {}),
    ...(imageUrl && imageAlt ? { imageAlt } : {}),
    faviconUrl: pickFavicon(doc, base),
    ...(themeColor ? { themeColor } : {}),
  }
}
