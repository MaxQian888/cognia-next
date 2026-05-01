/**
 * EPUB Parser - Extract readable text and metadata from .epub files.
 * Uses JSZip for archive access with lightweight XML/HTML extraction.
 */

export interface EPUBParseResult {
  text: string
  chapterCount: number
  chapters: EPUBChapter[]
  metadata: EPUBMetadata
}

export interface EPUBChapter {
  id: string
  href: string
  title?: string
  text: string
}

export interface EPUBMetadata {
  title?: string
  author?: string
  language?: string
  publisher?: string
  identifier?: string
}

/**
 * Parse EPUB data from ArrayBuffer.
 */
export async function parseEPUB(data: ArrayBuffer): Promise<EPUBParseResult> {
  const JSZip = (await import("jszip")).default

  let zip: Awaited<ReturnType<typeof JSZip.loadAsync>>
  try {
    zip = await JSZip.loadAsync(data)
  } catch {
    throw new Error("Failed to parse EPUB file. Ensure the file is a valid .epub.")
  }

  const containerPath = "META-INF/container.xml"
  const containerFile = zip.file(containerPath)
  if (!containerFile) {
    throw new Error("Invalid EPUB structure: missing META-INF/container.xml.")
  }

  const containerXml = await containerFile.async("string")
  const rootFilePath = extractRootFilePath(containerXml)
  if (!rootFilePath) {
    throw new Error("Invalid EPUB structure: unable to locate package document.")
  }

  const packageFile = zip.file(rootFilePath)
  if (!packageFile) {
    throw new Error(`Invalid EPUB structure: missing package file at ${rootFilePath}.`)
  }

  const packageXml = await packageFile.async("string")
  const metadata = extractMetadata(packageXml)
  const manifest = extractManifest(packageXml)
  const spineItemIds = extractSpineIds(packageXml)

  const basePath = getDirectory(rootFilePath)
  const chapters: EPUBChapter[] = []

  for (const id of spineItemIds) {
    const href = manifest[id]
    if (!href) {
      continue
    }

    const fullPath = normalizePath(`${basePath}${href}`)
    const chapterFile = zip.file(fullPath)
    if (!chapterFile) {
      continue
    }

    const html = await chapterFile.async("string")
    const text = extractTextFromMarkup(html)
    if (!text) {
      continue
    }

    const title = extractTagText(html, "title") || extractFirstHeading(html)
    chapters.push({
      id,
      href: fullPath,
      title,
      text,
    })
  }

  if (chapters.length === 0) {
    throw new Error("No readable chapter content found in EPUB file.")
  }

  const text = chapters
    .map((chapter, index) => `## ${chapter.title || `Chapter ${index + 1}`}\n${chapter.text}`)
    .join("\n\n")

  return {
    text,
    chapterCount: chapters.length,
    chapters,
    metadata,
  }
}

/**
 * Parse EPUB from File object.
 */
export async function parseEPUBFile(file: File): Promise<EPUBParseResult> {
  const buffer = await file.arrayBuffer()
  return parseEPUB(buffer)
}

/**
 * Build embedding-friendly text from parsed EPUB result.
 */
export function extractEPUBEmbeddableContent(result: EPUBParseResult): string {
  const parts: string[] = []

  if (result.metadata.title) {
    parts.push(`Title: ${result.metadata.title}`)
  }
  if (result.metadata.author) {
    parts.push(`Author: ${result.metadata.author}`)
  }

  parts.push(result.text)
  return parts.join("\n\n")
}

function extractRootFilePath(containerXml: string): string | undefined {
  const rootfileRegex = /<rootfile\b[^>]*\bfull-path=["']([^"']+)["'][^>]*>/i
  return rootfileRegex.exec(containerXml)?.[1]
}

function extractManifest(packageXml: string): Record<string, string> {
  const manifest: Record<string, string> = {}
  const itemRegex = /<item\b([^>]+?)\/?>/gi
  let match: RegExpExecArray | null

  while ((match = itemRegex.exec(packageXml)) !== null) {
    const attrs = match[1]
    const id = extractAttribute(attrs, "id")
    const href = extractAttribute(attrs, "href")
    if (id && href) {
      manifest[id] = href
    }
  }

  return manifest
}

function extractSpineIds(packageXml: string): string[] {
  const ids: string[] = []
  const itemRefRegex = /<itemref\b([^>]+?)\/?>/gi
  let match: RegExpExecArray | null

  while ((match = itemRefRegex.exec(packageXml)) !== null) {
    const idRef = extractAttribute(match[1], "idref")
    if (idRef) {
      ids.push(idRef)
    }
  }

  return ids
}

function extractMetadata(packageXml: string): EPUBMetadata {
  return {
    title: extractTagText(packageXml, "title"),
    author: extractTagText(packageXml, "creator"),
    language: extractTagText(packageXml, "language"),
    publisher: extractTagText(packageXml, "publisher"),
    identifier: extractTagText(packageXml, "identifier"),
  }
}

function extractTagText(xml: string, tag: string): string | undefined {
  const regex = new RegExp(`<(?:\\w+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`, "i")
  const match = xml.match(regex)
  if (!match) {
    return undefined
  }
  const value = decodeHtmlEntities(stripTags(match[1])).trim()
  return value || undefined
}

function extractFirstHeading(markup: string): string | undefined {
  const headingRegex = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i
  const match = markup.match(headingRegex)
  if (!match) {
    return undefined
  }
  const value = decodeHtmlEntities(stripTags(match[1])).trim()
  return value || undefined
}

function extractTextFromMarkup(markup: string): string {
  const withoutScripts = markup
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
  const withLineBreaks = withoutScripts
    .replace(/<\/(p|div|h[1-6]|li|section|article|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")

  const text = decodeHtmlEntities(stripTags(withLineBreaks))
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim()

  return text
}

function stripTags(input: string): string {
  return input.replace(/<[^>]+>/g, " ")
}

function extractAttribute(attrs: string, name: string): string | undefined {
  const regex = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i")
  return regex.exec(attrs)?.[1]
}

function getDirectory(path: string): string {
  const index = path.lastIndexOf("/")
  return index >= 0 ? path.slice(0, index + 1) : ""
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/{2,}/g, "/")
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
}
