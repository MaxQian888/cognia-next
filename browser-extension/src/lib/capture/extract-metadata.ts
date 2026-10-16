import type { BrowserPageMetadataV1 } from "@cognia/companion-client"
import { normalizeCaptureUrl } from "./normalize-url"

export function extractMetadata(doc: Document): BrowserPageMetadataV1 {
  const clean = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined
    return value.replace(/\s+/g, " ").trim().slice(0, 2048).trim() || undefined
  }
  const meta = (name: string): string | undefined =>
    clean(
      doc.querySelector(`meta[name="${name}"], meta[property="${name}"]`)?.getAttribute("content")
    )
  const records: Record<string, unknown>[] = []
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (!value || typeof value !== "object") return
    const record = value as Record<string, unknown>
    records.push(record)
    if (record["@graph"]) visit(record["@graph"])
  }
  for (const script of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      visit(JSON.parse(script.textContent ?? ""))
    } catch {
      /* A malformed publisher block is optional metadata. */
    }
  }
  // A graph often lists its publisher before the article it describes.
  const pageRecord = (record: Record<string, unknown>): number =>
    /article|posting|video|product|webpage/i.test(String(record["@type"] ?? "")) ? 1 : 0
  records.sort((a, b) => pageRecord(b) - pageRecord(a))
  const names = (value: unknown): string | undefined => {
    if (Array.isArray(value)) return clean(value.map(names).filter(Boolean).join(", "))
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>
      return (
        clean(record.name) ||
        (typeof record["@id"] === "string"
          ? clean(records.find((item) => item["@id"] === record["@id"] && clean(item.name))?.name)
          : undefined)
      )
    }
    return clean(value)
  }
  const json = (key: string, read = clean): string | undefined => {
    for (const record of records) {
      const value = read(record[key])
      if (value) return value
    }
    return undefined
  }
  const content = (selector: string): string | undefined => {
    const element = doc.querySelector(selector)
    return clean(element?.getAttribute("content")) || clean(element?.textContent)
  }
  const metadata: BrowserPageMetadataV1 = {}
  const set = (key: keyof BrowserPageMetadataV1, value: unknown): void => {
    const normalized = clean(value)
    if (normalized) metadata[key] = normalized
  }
  set(
    "byline",
    meta("author") ||
      meta("article:author") ||
      json("author", names) ||
      content('[rel~="author"]') ||
      content('[itemprop="author"]')
  )
  set(
    "publishedAt",
    meta("article:published_time") ||
      json("datePublished") ||
      clean(
        doc
          .querySelector(
            'article time[datetime], main time[datetime], [role="main"] time[datetime], [itemprop="articleBody"] time[datetime]'
          )
          ?.getAttribute("datetime")
      ) ||
      clean(doc.querySelector('[itemprop="datePublished"]')?.getAttribute("datetime")) ||
      content('[itemprop="datePublished"]')
  )
  set("siteName", meta("og:site_name") || meta("application-name") || json("publisher", names))
  set("lang", clean(doc.documentElement.lang) || meta("og:locale")?.replace(/_/g, "-"))
  set("description", meta("description") || meta("og:description"))
  set(
    "kind",
    (
      meta("og:type") || json("@type", (value) => clean(Array.isArray(value) ? value[0] : value))
    )?.toLowerCase()
  )
  const canonical = doc.querySelector('link[rel~="canonical"]')?.getAttribute("href")
  if (canonical?.trim()) {
    try {
      const url = new URL(canonical, doc.baseURI)
      url.hash = ""
      const normalized = normalizeCaptureUrl(url.href, true)
      if (normalized.ok) set("canonicalUrl", normalized.url)
    } catch {
      /* Ignore a publisher's invalid URL without losing other fields. */
    }
  }
  return metadata
}
