/**
 * Presentation Parser - Extract text content from PowerPoint (.pptx) files.
 * Uses JSZip to read slide XML and metadata.
 */

export interface PresentationParseResult {
  text: string
  slideCount: number
  slides: PresentationSlide[]
  metadata: PresentationMetadata
}

export interface PresentationSlide {
  slideNumber: number
  title?: string
  text: string
}

export interface PresentationMetadata {
  title?: string
  author?: string
  lastModifiedBy?: string
  created?: Date
  modified?: Date
}

/**
 * Parse PPTX data from ArrayBuffer.
 */
export async function parsePresentation(data: ArrayBuffer): Promise<PresentationParseResult> {
  const JSZip = (await import("jszip")).default

  let zip: Awaited<ReturnType<typeof JSZip.loadAsync>>
  try {
    zip = await JSZip.loadAsync(data)
  } catch {
    throw new Error("Failed to parse presentation file. Ensure the file is a valid .pptx.")
  }

  const slidePaths = Object.keys(zip.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/i.test(path))
    .sort((a, b) => getSlideNumber(a) - getSlideNumber(b))

  if (slidePaths.length === 0) {
    throw new Error("No slide content found in presentation file.")
  }

  const slides: PresentationSlide[] = []

  for (const slidePath of slidePaths) {
    const slideFile = zip.file(slidePath)
    if (!slideFile) {
      continue
    }

    const xml = await slideFile.async("string")
    const slideText = extractSlideText(xml)

    if (!slideText) {
      continue
    }

    const lines = slideText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
    slides.push({
      slideNumber: getSlideNumber(slidePath),
      title: lines[0],
      text: slideText,
    })
  }

  if (slides.length === 0) {
    throw new Error("No readable text content found in presentation file.")
  }

  const metadata = await extractPresentationMetadata(zip)
  const text = slides.map((slide) => `## Slide ${slide.slideNumber}\n${slide.text}`).join("\n\n")

  return {
    text,
    slideCount: slides.length,
    slides,
    metadata,
  }
}

/**
 * Parse PPTX from File object.
 */
export async function parsePresentationFile(file: File): Promise<PresentationParseResult> {
  const buffer = await file.arrayBuffer()
  return parsePresentation(buffer)
}

/**
 * Build embedding-friendly text from parsed presentation result.
 */
export function extractPresentationEmbeddableContent(result: PresentationParseResult): string {
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

function getSlideNumber(path: string): number {
  const match = path.match(/slide(\d+)\.xml$/i)
  return match ? Number(match[1]) : 0
}

function extractSlideText(xml: string): string {
  const texts: string[] = []
  const textRegex = /<a:t>([\s\S]*?)<\/a:t>/gi
  let match: RegExpExecArray | null

  while ((match = textRegex.exec(xml)) !== null) {
    const value = decodeXmlEntities(match[1]).trim()
    if (value) {
      texts.push(value)
    }
  }

  return texts
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

interface ZipTextFileLike {
  async: (type: "string") => Promise<string>
}

interface ZipLike {
  file: (path: string) => ZipTextFileLike | null
}

async function extractPresentationMetadata(zip: ZipLike): Promise<PresentationMetadata> {
  const coreFile = zip.file("docProps/core.xml")
  if (!coreFile) {
    return {}
  }

  const xml = await coreFile.async("string")

  return {
    title: extractTagText(xml, "title"),
    author: extractTagText(xml, "creator"),
    lastModifiedBy: extractTagText(xml, "lastModifiedBy"),
    created: parseXmlDate(extractTagText(xml, "created")),
    modified: parseXmlDate(extractTagText(xml, "modified")),
  }
}

function extractTagText(xml: string, tag: string): string | undefined {
  const regex = new RegExp(`<(?:\\w+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`, "i")
  const match = xml.match(regex)
  if (!match) {
    return undefined
  }
  const value = decodeXmlEntities(match[1]).trim()
  return value || undefined
}

function parseXmlDate(value?: string): Date | undefined {
  if (!value) {
    return undefined
  }
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

function decodeXmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
}
