/**
 * HTML Parser - Extract text and structure from HTML content
 * Uses cheerio for parsing
 */

import type { CheerioAPI } from "cheerio"
import { getDocumentLogger } from "../runtime-adapters"

const log = getDocumentLogger()

interface CheerioElement {
  tagName: string
}

export interface HTMLParseResult {
  text: string
  title?: string
  headings: HTMLHeading[]
  links: HTMLLink[]
  images: HTMLImage[]
  metadata: HTMLMetadata
  tables: HTMLTable[]
}

export interface HTMLHeading {
  level: number
  text: string
}

export interface HTMLLink {
  text: string
  href: string
  isExternal: boolean
}

export interface HTMLImage {
  src: string
  alt: string
  title?: string
}

export interface HTMLMetadata {
  title?: string
  description?: string
  keywords?: string[]
  author?: string
  ogTitle?: string
  ogDescription?: string
  ogImage?: string
}

export interface HTMLTable {
  headers: string[]
  rows: string[][]
  caption?: string
}

export interface HTMLParseOptions {
  includeLinks?: boolean
  includeImages?: boolean
  includeTables?: boolean
  baseUrl?: string
}

const DEFAULT_OPTIONS: HTMLParseOptions = {
  includeLinks: true,
  includeImages: true,
  includeTables: true,
}

/**
 * Parse HTML content
 */
export async function parseHTML(
  content: string,
  options: HTMLParseOptions = {}
): Promise<HTMLParseResult> {
  const cheerio = await import("cheerio")
  const $ = cheerio.load(content)
  const opts = { ...DEFAULT_OPTIONS, ...options }

  // Remove script and style elements
  $("script, style, noscript").remove()

  // Extract metadata
  const metadata = extractMetadata($)

  // Extract title
  const title = $("title").text().trim() || metadata.title

  // Extract headings
  const headings = extractHeadings($)

  // Extract links
  const links = opts.includeLinks ? extractLinks($, opts.baseUrl) : []

  // Extract images
  const images = opts.includeImages ? extractImages($, opts.baseUrl) : []

  // Extract tables
  const tables = opts.includeTables ? extractTables($) : []

  // Extract main text content
  const text = extractText($, title, headings, tables)

  return {
    text,
    title,
    headings,
    links,
    images,
    metadata,
    tables,
  }
}

/**
 * Extract metadata from HTML
 */
function extractMetadata($: CheerioAPI): HTMLMetadata {
  const getMeta = (name: string): string | undefined => {
    return (
      $(`meta[name="${name}"]`).attr("content") ||
      $(`meta[property="${name}"]`).attr("content") ||
      undefined
    )
  }

  const keywords = getMeta("keywords")

  return {
    title: $("title").text().trim() || undefined,
    description: getMeta("description"),
    keywords: keywords ? keywords.split(",").map((k) => k.trim()) : undefined,
    author: getMeta("author"),
    ogTitle: getMeta("og:title"),
    ogDescription: getMeta("og:description"),
    ogImage: getMeta("og:image"),
  }
}

/**
 * Extract headings from HTML
 */
function extractHeadings($: CheerioAPI): HTMLHeading[] {
  const headings: HTMLHeading[] = []

  $("h1, h2, h3, h4, h5, h6").each((_, el) => {
    const tagName = (el as CheerioElement).tagName.toLowerCase()
    const level = parseInt(tagName.charAt(1), 10)
    const text = $(el).text().trim()

    if (text) {
      headings.push({ level, text })
    }
  })

  return headings
}

/**
 * Extract links from HTML
 */
function extractLinks($: CheerioAPI, baseUrl?: string): HTMLLink[] {
  const links: HTMLLink[] = []
  const seen = new Set<string>()

  $("a[href]").each((_, el) => {
    let href = $(el).attr("href") || ""
    const text = $(el).text().trim()

    // Skip empty links and anchors
    if (!href || href.startsWith("#") || href.startsWith("javascript:")) {
      return
    }

    // Resolve relative URLs
    if (baseUrl && !href.startsWith("http")) {
      try {
        href = new URL(href, baseUrl).href
      } catch (error) {
        log.warn(`Failed to resolve relative URL: ${href}`, { error })
        // Keep original href if URL parsing fails
      }
    }

    // Skip duplicates
    if (seen.has(href)) {
      return
    }
    seen.add(href)

    const isExternal = isExternalHref(href, baseUrl)

    links.push({
      text: text || href,
      href,
      isExternal,
    })
  })

  return links
}

function isExternalHref(href: string, baseUrl?: string): boolean {
  if (!href.startsWith("http")) return false
  if (!baseUrl) return true

  try {
    return new URL(href).origin !== new URL(baseUrl).origin
  } catch {
    return !href.startsWith(baseUrl)
  }
}

/**
 * Extract images from HTML
 */
function extractImages($: CheerioAPI, baseUrl?: string): HTMLImage[] {
  const images: HTMLImage[] = []
  const seen = new Set<string>()

  $("img[src]").each((_, el) => {
    let src = $(el).attr("src") || ""
    const alt = $(el).attr("alt") || ""
    const title = $(el).attr("title")

    // Skip data URLs and empty sources
    if (!src || src.startsWith("data:")) {
      return
    }

    // Resolve relative URLs
    if (baseUrl && !src.startsWith("http")) {
      try {
        src = new URL(src, baseUrl).href
      } catch (error) {
        log.warn(`Failed to resolve relative image URL: ${src}`, { error })
        // Keep original src if URL parsing fails
      }
    }

    // Skip duplicates
    if (seen.has(src)) {
      return
    }
    seen.add(src)

    images.push({
      src,
      alt,
      title: title || undefined,
    })
  })

  return images
}

/**
 * Extract tables from HTML
 */
function extractTables($: CheerioAPI): HTMLTable[] {
  const tables: HTMLTable[] = []

  $("table").each((_, tableEl) => {
    const $table = $(tableEl)
    const caption = $table.find("caption").text().trim() || undefined

    // Extract headers
    const headers: string[] = []
    $table.find("thead th, thead td, tr:first-child th").each((_, th) => {
      headers.push($(th).text().trim())
    })

    // Extract rows
    const rows: string[][] = []
    const rowSelector = headers.length > 0 ? "tbody tr, tr:not(:first-child)" : "tr"

    $table.find(rowSelector).each((_, tr) => {
      const row: string[] = []
      $(tr)
        .find("td, th")
        .each((_, cell) => {
          row.push($(cell).text().trim())
        })
      if (row.length > 0) {
        rows.push(row)
      }
    })

    if (headers.length > 0 || rows.length > 0) {
      tables.push({ headers, rows, caption })
    }
  })

  return tables
}

/**
 * Extract plain text from HTML
 */
function extractText(
  $: CheerioAPI,
  title?: string,
  headings?: HTMLHeading[],
  tables?: HTMLTable[]
): string {
  const parts: string[] = []

  if (title) {
    parts.push(`# ${title}`)
    parts.push("")
  }

  // Get body text with structure preserved
  const body = $("body").length > 0 ? $("body") : $("html")

  // Process main content areas first
  const mainContent = $('main, article, [role="main"]')
  const contentRoot = mainContent.length > 0 ? mainContent : body

  // Extract text with basic formatting
  const textContent = contentRoot
    .clone()
    .find('nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"]')
    .remove()
    .end()
    .text()
    .replace(/\s+/g, " ")
    .trim()

  if (textContent) {
    parts.push(textContent)
  }

  // Add table summaries
  if (tables && tables.length > 0) {
    parts.push("")
    parts.push("## Tables")
    for (const table of tables) {
      if (table.caption) {
        parts.push(`### ${table.caption}`)
      }
      if (table.headers.length > 0) {
        parts.push(`Columns: ${table.headers.join(", ")}`)
      }
      parts.push(`Rows: ${table.rows.length}`)
    }
  }

  return parts.join("\n")
}

/**
 * Parse HTML file
 */
export async function parseHTMLFile(
  file: File,
  options: HTMLParseOptions = {}
): Promise<HTMLParseResult> {
  const content = await file.text()
  return parseHTML(content, options)
}

/**
 * Extract embeddable content from HTML
 */
export function extractHTMLEmbeddableContent(result: HTMLParseResult): string {
  const parts: string[] = []

  if (result.title) {
    parts.push(result.title)
  }

  if (result.metadata.description) {
    parts.push(result.metadata.description)
  }

  parts.push(result.text)

  return parts.join("\n\n")
}

/**
 * Convert HTML to Markdown-like text
 */
export async function htmlToMarkdown(content: string): Promise<string> {
  const cheerio = await import("cheerio")
  const $ = cheerio.load(content)

  // Remove unwanted elements
  $("script, style, noscript, nav, footer, header").remove()

  // Inline elements FIRST — otherwise flattening a block via `.text()` strips
  // the inner anchors/emphasis before their own pass runs (the historical bug:
  // links inside <p> were lost). Innermost → outermost: code, strong, em, a.
  $("code").each((_, el) => {
    const text = $(el).text().trim()
    $(el).replaceWith(`\`${text}\``)
  })
  $("strong, b").each((_, el) => {
    const text = $(el).text().trim()
    if (text) $(el).replaceWith(`**${text}**`)
  })
  $("em, i").each((_, el) => {
    const text = $(el).text().trim()
    if (text) $(el).replaceWith(`*${text}*`)
  })
  $("a").each((_, el) => {
    const text = $(el).text().trim()
    const href = $(el).attr("href") || ""
    $(el).replaceWith(href && text ? `[${text}](${href})` : text)
  })
  // Images — WeChat/article bodies lazy-load via data-src.
  $("img").each((_, el) => {
    const alt = $(el).attr("alt")?.trim() || ""
    const src = $(el).attr("src") || $(el).attr("data-src") || ""
    $(el).replaceWith(src ? `![${alt}](${src})` : "")
  })
  // Line breaks.
  $("br").each((_, el) => {
    $(el).replaceWith("\n")
  })

  // Block elements.
  $("h1, h2, h3, h4, h5, h6").each((_, el) => {
    const level = parseInt((el as CheerioElement).tagName.charAt(1), 10)
    const text = $(el).text().trim()
    $(el).replaceWith(`\n${"#".repeat(level)} ${text}\n`)
  })
  $("blockquote").each((_, el) => {
    const text = $(el).text().trim()
    if (text) $(el).replaceWith(`\n> ${text.split("\n").join("\n> ")}\n`)
  })
  $("pre").each((_, el) => {
    const text = $(el).text().replace(/\s+$/, "")
    $(el).replaceWith(`\n\`\`\`\n${text}\n\`\`\`\n`)
  })
  $("ul, ol").each((_, el) => {
    const isOrdered = (el as CheerioElement).tagName === "ol"
    $(el)
      .find("li")
      .each((i, li) => {
        const text = $(li).text().trim()
        const prefix = isOrdered ? `${i + 1}.` : "-"
        $(li).replaceWith(`${prefix} ${text}\n`)
      })
  })
  $("p").each((_, el) => {
    const text = $(el).text().trim()
    $(el).replaceWith(`\n${text}\n`)
  })

  // Get final text
  let markdown = $("body").text() || $.root().text()

  // Clean up whitespace
  markdown = markdown
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

  return markdown
}
