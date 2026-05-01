/**
 * OpenDocument Parser - Extract readable content from ODT/ODS/ODP archives.
 * Uses JSZip to read XML payloads and normalizes them into existing parser contracts.
 */

import type { ExcelParseResult, ExcelSheet, WordParseResult } from "./office-parser"
import type {
  PresentationMetadata,
  PresentationParseResult,
  PresentationSlide,
} from "./presentation-parser"

interface ZipTextFileLike {
  async: (type: "string") => Promise<string>
}

interface ZipLike {
  file: (path: string) => ZipTextFileLike | null
}

export async function parseOpenDocumentText(data: ArrayBuffer): Promise<WordParseResult> {
  const zip = await loadOpenDocumentZip(data)
  await assertNotEncrypted(zip)

  const contentXml = await readRequiredText(zip, "content.xml")
  const blocks = extractOrderedTextBlocks(contentXml, ["text:h", "text:p"])
  const text = blocks
    .map((block) => block.text)
    .filter(Boolean)
    .join("\n\n")
    .trim()

  if (!text) {
    throw new Error("No readable text content found in OpenDocument file.")
  }

  const metadata = await extractOpenDocumentMetadata(zip)
  const headings = blocks
    .filter((block) => block.tag === "text:h")
    .map((block) => ({
      level: Math.max(Number(block.attributes["text:outline-level"] || 1), 1),
      text: block.text,
    }))

  return {
    text,
    html: blocks.map((block) => `<p>${escapeHtml(block.text)}</p>`).join(""),
    messages: [],
    images: [],
    metadata,
    headings,
  }
}

export async function parseOpenDocumentSpreadsheet(data: ArrayBuffer): Promise<ExcelParseResult> {
  const zip = await loadOpenDocumentZip(data)
  await assertNotEncrypted(zip)

  const contentXml = await readRequiredText(zip, "content.xml")
  const tables = extractTables(contentXml)

  if (tables.length === 0) {
    throw new Error("No readable spreadsheet content found in OpenDocument file.")
  }

  const sheets: ExcelSheet[] = tables.map((table) => {
    const rows = extractTableRows(table.innerXml)
    const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0)

    return {
      name: table.name,
      data: rows,
      rowCount: rows.length,
      columnCount,
    }
  })

  return {
    text: sheets.map((sheet) => convertSheetToText(sheet)).join("\n\n"),
    sheets,
    sheetNames: sheets.map((sheet) => sheet.name),
  }
}

export async function parseOpenDocumentPresentation(
  data: ArrayBuffer
): Promise<PresentationParseResult> {
  const zip = await loadOpenDocumentZip(data)
  await assertNotEncrypted(zip)

  const contentXml = await readRequiredText(zip, "content.xml")
  const slides = extractSlides(contentXml)

  if (slides.length === 0) {
    throw new Error("No readable slide content found in OpenDocument file.")
  }

  const metadata = await extractOpenDocumentMetadata(zip)

  return {
    text: slides.map((slide) => `## Slide ${slide.slideNumber}\n${slide.text}`).join("\n\n"),
    slideCount: slides.length,
    slides,
    metadata: toPresentationMetadata(metadata),
  }
}

async function loadOpenDocumentZip(data: ArrayBuffer) {
  const JSZip = (await import("jszip")).default

  try {
    return await JSZip.loadAsync(data)
  } catch {
    throw new Error("Failed to parse OpenDocument file. Ensure the file is a valid archive.")
  }
}

async function assertNotEncrypted(zip: ZipLike): Promise<void> {
  const manifestFile = zip.file("META-INF/manifest.xml")
  if (!manifestFile) {
    return
  }

  const manifestXml = await manifestFile.async("string")
  if (/<(?:\w+:)?encryption-data\b/i.test(manifestXml)) {
    throw new Error(
      "OpenDocument file appears to be password protected. Remove protection and retry."
    )
  }
}

async function readRequiredText(zip: ZipLike, path: string): Promise<string> {
  const file = zip.file(path)
  if (!file) {
    throw new Error(`Missing required OpenDocument entry: ${path}`)
  }

  return file.async("string")
}

async function extractOpenDocumentMetadata(
  zip: ZipLike
): Promise<{ title?: string; author?: string }> {
  const metaFile = zip.file("meta.xml")
  if (!metaFile) {
    return {}
  }

  const xml = await metaFile.async("string")
  return {
    title: extractTagText(xml, ["dc:title"]),
    author: extractTagText(xml, ["dc:creator", "meta:initial-creator"]),
  }
}

function toPresentationMetadata(metadata: {
  title?: string
  author?: string
}): PresentationMetadata {
  return {
    title: metadata.title,
    author: metadata.author,
  }
}

function extractOrderedTextBlocks(xml: string, tags: string[]) {
  const escapedTags = tags.map(escapeTagName).join("|")
  const regex = new RegExp(`<(${escapedTags})\\b([^>]*)>([\\s\\S]*?)<\\/\\1>`, "gi")
  const blocks: Array<{ tag: string; text: string; attributes: Record<string, string> }> = []
  let match: RegExpExecArray | null

  while ((match = regex.exec(xml)) !== null) {
    const text = normalizeXmlText(match[3])
    if (!text) {
      continue
    }

    blocks.push({
      tag: match[1],
      text,
      attributes: parseAttributes(match[2]),
    })
  }

  return blocks
}

function extractTables(xml: string): Array<{ name: string; innerXml: string }> {
  const regex = /<table:table\b([^>]*)>([\s\S]*?)<\/table:table>/gi
  const tables: Array<{ name: string; innerXml: string }> = []
  let match: RegExpExecArray | null

  while ((match = regex.exec(xml)) !== null) {
    const attributes = parseAttributes(match[1])
    tables.push({
      name: attributes["table:name"] || `Sheet ${tables.length + 1}`,
      innerXml: match[2],
    })
  }

  return tables
}

function extractTableRows(tableXml: string): string[][] {
  const rowRegex = /<table:table-row\b([^>]*)>([\s\S]*?)<\/table:table-row>/gi
  const rows: string[][] = []
  let rowMatch: RegExpExecArray | null

  while ((rowMatch = rowRegex.exec(tableXml)) !== null) {
    const rowRepeat = Math.max(
      Number(parseAttributes(rowMatch[1])["table:number-rows-repeated"] || 1),
      1
    )
    const row = extractCells(rowMatch[2])

    for (let i = 0; i < rowRepeat; i++) {
      rows.push([...row])
    }
  }

  return rows
}

function extractCells(rowXml: string): string[] {
  const cellRegex = /<table:table-cell\b([^>]*)>([\s\S]*?)<\/table:table-cell>/gi
  const cells: string[] = []
  let cellMatch: RegExpExecArray | null

  while ((cellMatch = cellRegex.exec(rowXml)) !== null) {
    const attributes = parseAttributes(cellMatch[1])
    const repeat = Math.max(Number(attributes["table:number-columns-repeated"] || 1), 1)
    const paragraphs = extractOrderedTextBlocks(cellMatch[2], ["text:p"]).map((block) => block.text)
    const value = paragraphs.join("\n").trim()

    for (let i = 0; i < repeat; i++) {
      cells.push(value)
    }
  }

  return cells
}

function extractSlides(xml: string): PresentationSlide[] {
  const pageRegex = /<draw:page\b([^>]*)>([\s\S]*?)<\/draw:page>/gi
  const slides: PresentationSlide[] = []
  let match: RegExpExecArray | null

  while ((match = pageRegex.exec(xml)) !== null) {
    const textBlocks = extractOrderedTextBlocks(match[2], ["text:h", "text:p"])
    const slideText = textBlocks
      .map((block) => block.text)
      .filter(Boolean)
      .join("\n")
      .trim()
    if (!slideText) {
      continue
    }

    const slideNumber = slides.length + 1
    slides.push({
      slideNumber,
      title: textBlocks[0]?.text,
      text: slideText,
    })
  }

  return slides
}

function convertSheetToText(sheet: ExcelSheet): string {
  const lines = [`## Sheet: ${sheet.name}`]

  for (const row of sheet.data) {
    lines.push(row.join(" | "))
  }

  return lines.join("\n")
}

function parseAttributes(attributes: string): Record<string, string> {
  const result: Record<string, string> = {}
  const regex = /([\w:-]+)="([^"]*)"/g
  let match: RegExpExecArray | null

  while ((match = regex.exec(attributes)) !== null) {
    result[match[1]] = decodeXmlEntities(match[2])
  }

  return result
}

function extractTagText(xml: string, tags: string[]): string | undefined {
  for (const tag of tags) {
    const regex = new RegExp(
      `<${escapeTagName(tag)}[^>]*>([\\s\\S]*?)<\\/${escapeTagName(tag)}>`,
      "i"
    )
    const match = xml.match(regex)
    if (!match) {
      continue
    }

    const text = normalizeXmlText(match[1])
    if (text) {
      return text
    }
  }

  return undefined
}

function normalizeXmlText(input: string): string {
  return decodeXmlEntities(input.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
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

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function escapeTagName(tag: string): string {
  return tag.replace(":", "\\:")
}
