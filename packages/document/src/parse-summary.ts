/**
 * Parse Summary - Normalization adapters for per-format parse results
 * Converts raw parser output into a unified ParseSummary structure
 */

import type {
  ParseSummary,
  ParseSummarySegment,
  DocumentMetadata,
  PDFParseResult,
  WordParseResult,
  ExcelParseResult,
  PresentationParseResult,
  EPUBParseResult,
  HTMLParseResult,
  CSVParseResult,
  RTFParseResult,
  MarkdownParseResult,
  CodeParseResult,
} from "./types"

export function normalizePDFSummary(parsed: PDFParseResult): ParseSummary {
  const segments: ParseSummarySegment[] = parsed.pages.map((page, i) => ({
    kind: "page" as const,
    index: i,
    title: `Page ${page.pageNumber}`,
  }))

  return {
    parser: "pdf",
    structure: {
      segmentCount: parsed.pages.length,
      pageCount: parsed.pageCount,
    },
    segments,
    quality: { status: "complete" },
  }
}

export function normalizeWordSummary(parsed: WordParseResult): ParseSummary {
  const headings = parsed.headings ?? []
  const segments: ParseSummarySegment[] = headings.map((h, i) => ({
    kind: "heading" as const,
    index: i,
    title: h.text,
    level: h.level,
  }))

  return {
    parser: "word",
    structure: {
      segmentCount: headings.length,
      headingCount: headings.length,
      imageCount: parsed.images.length,
    },
    segments,
    quality: {
      status: parsed.messages.length > 0 ? "degraded" : "complete",
      reason:
        parsed.messages.length > 0 ? `${parsed.messages.length} parser warning(s)` : undefined,
    },
  }
}

export function normalizeExcelSummary(parsed: ExcelParseResult): ParseSummary {
  const segments: ParseSummarySegment[] = parsed.sheets.map((sheet, i) => ({
    kind: "sheet" as const,
    index: i,
    title: sheet.name,
  }))

  return {
    parser: "excel",
    structure: {
      segmentCount: parsed.sheets.length,
      sheetCount: parsed.sheets.length,
    },
    segments,
    quality: { status: "complete" },
  }
}

export function normalizePresentationSummary(parsed: PresentationParseResult): ParseSummary {
  const segments: ParseSummarySegment[] = parsed.slides.map((slide, i) => ({
    kind: "slide" as const,
    index: i,
    title: slide.title,
  }))

  return {
    parser: "presentation",
    structure: {
      segmentCount: parsed.slides.length,
      slideCount: parsed.slideCount,
    },
    segments,
    quality: { status: "complete" },
  }
}

export function normalizeEPUBSummary(parsed: EPUBParseResult): ParseSummary {
  const segments: ParseSummarySegment[] = parsed.chapters.map((ch, i) => ({
    kind: "chapter" as const,
    index: i,
    title: ch.title,
  }))

  return {
    parser: "epub",
    structure: {
      segmentCount: parsed.chapters.length,
      chapterCount: parsed.chapterCount,
    },
    segments,
    quality: { status: "complete" },
  }
}

export function normalizeHTMLSummary(parsed: HTMLParseResult): ParseSummary {
  const segments: ParseSummarySegment[] = parsed.headings.map((h, i) => ({
    kind: "heading" as const,
    index: i,
    title: h.text,
    level: h.level,
  }))

  return {
    parser: "html",
    structure: {
      segmentCount: parsed.headings.length,
      headingCount: parsed.headings.length,
      tableCount: parsed.tables.length,
      linkCount: parsed.links.length,
      imageCount: parsed.images.length,
    },
    segments,
    quality: { status: "complete" },
  }
}

export function normalizeCSVSummary(_parsed: CSVParseResult): ParseSummary {
  return {
    parser: "csv",
    structure: {
      segmentCount: 1,
      tableCount: 1,
    },
    quality: { status: "complete" },
  }
}

export function normalizeRTFSummary(_parsed: RTFParseResult): ParseSummary {
  return {
    parser: "rtf",
    structure: {
      segmentCount: 1,
    },
    quality: { status: "complete" },
  }
}

export function normalizeMarkdownSummary(parsed: MarkdownParseResult): ParseSummary {
  const segments: ParseSummarySegment[] = parsed.sections.map((s, i) => ({
    kind: "section" as const,
    index: i,
    title: s.title,
    level: s.level,
  }))

  return {
    parser: "markdown",
    structure: {
      segmentCount: parsed.sections.length,
      sectionCount: parsed.sections.length,
      headingCount: parsed.sections.length,
      codeBlockCount: parsed.codeBlocks.length,
      linkCount: parsed.links.length,
      imageCount: parsed.images.length,
      tableCount: 0,
    },
    segments,
    quality: { status: "complete" },
  }
}

export function normalizeCodeSummary(parsed: CodeParseResult): ParseSummary {
  const segments: ParseSummarySegment[] = [
    ...parsed.functions.map((fn, i) => ({
      kind: "code-block" as const,
      index: i,
      title: fn.name,
    })),
    ...parsed.classes.map((cls, i) => ({
      kind: "section" as const,
      index: parsed.functions.length + i,
      title: cls.name,
    })),
  ]

  return {
    parser: "code",
    structure: {
      segmentCount: parsed.functions.length + parsed.classes.length,
      codeBlockCount: parsed.functions.length,
      sectionCount: parsed.classes.length,
    },
    segments,
    quality: { status: "complete" },
  }
}

export function normalizeTextSummary(_metadata: DocumentMetadata): ParseSummary {
  return {
    parser: "text",
    structure: {
      segmentCount: 1,
    },
    quality: { status: "complete" },
  }
}

export function normalizeJSONSummary(_metadata: DocumentMetadata): ParseSummary {
  return {
    parser: "json",
    structure: {
      segmentCount: 1,
    },
    quality: { status: "complete" },
  }
}
