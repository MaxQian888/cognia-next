/**
 * Document Processor - Unified document processing for various file types
 * Enhanced with file validation, encoding detection, CJK token estimation, document comparison
 */

import {
  parseMarkdown,
  extractEmbeddableContent as extractMarkdownContent,
} from "./parsers/markdown-parser"
import { parseCode, extractCodeEmbeddableContent, detectLanguage } from "./parsers/code-parser"
import { chunkDocument, type ChunkingOptions } from "@/lib/ai/embedding/chunking"
import {
  detectDocumentTypeFromFilename,
  getFilenameExtension,
  isBinaryDocumentType,
} from "./support-matrix"
import {
  normalizeMarkdownSummary,
  normalizeCodeSummary,
  normalizeJSONSummary,
  normalizeTextSummary,
  normalizePDFSummary,
  normalizeWordSummary,
  normalizeExcelSummary,
  normalizePresentationSummary,
  normalizeRTFSummary,
  normalizeEPUBSummary,
  normalizeCSVSummary,
  normalizeHTMLSummary,
} from "./parse-summary"
import { mapWordMessages, attachDiagnosticToError } from "./parse-diagnostics"

// Re-export canonical types from @/types/document for API compatibility
export type { DocumentType, DocumentMetadata, ProcessedDocument } from "@/types/document"
import type {
  DocumentType,
  DocumentMetadata,
  ProcessedDocument,
  ParseSummary,
  ParseDiagnostic,
  WordParseResult,
} from "@/types/document"

export interface ProcessingOptions {
  extractEmbeddable?: boolean
  generateChunks?: boolean
  chunkingOptions?: Partial<ChunkingOptions>
  maxFileSize?: number
}

export interface ValidationOptions {
  maxFileSize?: number
  allowedTypes?: DocumentType[]
}

export interface ValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}

export interface DocumentDiff {
  added: string[]
  removed: string[]
  modified: { line: number; before: string; after: string }[]
  similarity: number
}

const DEFAULT_PROCESSING_OPTIONS: ProcessingOptions = {
  extractEmbeddable: true,
  generateChunks: false,
}

/**
 * Detect document type from filename
 */
export function detectDocumentType(filename: string): DocumentType {
  return detectDocumentTypeFromFilename(filename)
}

/**
 * Count words in text
 */
function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length
}

function normalizeDocumentParseError(label: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : ""

  if (
    /password protected|encrypted|no readable|legacy powerpoint|convert to \.pptx/i.test(message)
  ) {
    const err = error instanceof Error ? error : new Error(message)
    return attachDiagnosticToError(err, {
      code: "parse_failed",
      severity: "error",
      message: err.message,
    })
  }

  const err = new Error(
    `Failed to parse ${label} file. Ensure the file is not password protected or corrupted, then retry.`
  )
  return attachDiagnosticToError(err, {
    code: "parse_failed",
    severity: "error",
    message: err.message,
  })
}

/**
 * Process a text-based document (sync version)
 * For binary documents (PDF, Word, Excel, Presentation, EPUB), use processDocumentAsync
 */
export function processDocument(
  id: string,
  filename: string,
  content: string,
  options: ProcessingOptions = {}
): ProcessedDocument {
  const opts = { ...DEFAULT_PROCESSING_OPTIONS, ...options }
  const type = detectDocumentType(filename)
  const lines = content.split("\n")

  let embeddableContent = content
  let metadata: DocumentMetadata = {
    size: content.length,
    lineCount: lines.length,
    wordCount: countWords(content),
  }

  let parseSummary: ParseSummary | undefined

  // Process based on type
  switch (type) {
    case "markdown": {
      const parsed = parseMarkdown(content)
      if (opts.extractEmbeddable) {
        embeddableContent = extractMarkdownContent(content)
      }
      metadata = {
        ...metadata,
        title: parsed.title,
        language: "markdown",
        tags: parsed.frontmatter?.tags as string[] | undefined,
      }
      parseSummary = normalizeMarkdownSummary(parsed)
      break
    }

    case "code": {
      const parsed = parseCode(content, filename)
      if (opts.extractEmbeddable) {
        embeddableContent = extractCodeEmbeddableContent(content, filename)
      }
      metadata = {
        ...metadata,
        language: parsed.language,
        functionCount: parsed.functions.length,
        importCount: parsed.imports.length,
      }
      parseSummary = normalizeCodeSummary(parsed)
      break
    }

    case "json": {
      try {
        const parsed = JSON.parse(content)
        metadata = {
          ...metadata,
          language: "json",
          isArray: Array.isArray(parsed),
          keyCount: typeof parsed === "object" && parsed !== null ? Object.keys(parsed).length : 0,
        }
      } catch {
        // Invalid JSON, treat as text
      }
      parseSummary = normalizeJSONSummary(metadata)
      break
    }

    case "text":
    default: {
      metadata = {
        ...metadata,
        language: detectLanguage(filename),
      }
      parseSummary = normalizeTextSummary(metadata)
      break
    }
  }

  if (parseSummary) {
    metadata = { ...metadata, parseSummary }
  }

  const result: ProcessedDocument = {
    id,
    filename,
    type,
    content,
    embeddableContent,
    metadata,
    parseSummary,
    parseDiagnostics: [],
  }

  // Generate chunks if requested
  if (opts.generateChunks) {
    const strategy = opts.chunkingOptions?.strategy ?? "semantic"
    // In sync version, always use sync chunking
    const chunkResult = chunkDocument(embeddableContent, { strategy, ...opts.chunkingOptions }, id)

    result.chunks = chunkResult.chunks
  }

  return result
}

/**
 * Process a document asynchronously (supports binary and rich formats)
 */
export async function processDocumentAsync(
  id: string,
  filename: string,
  data: string | ArrayBuffer,
  options: ProcessingOptions = {}
): Promise<ProcessedDocument> {
  const opts = { ...DEFAULT_PROCESSING_OPTIONS, ...options }
  const type = detectDocumentType(filename)

  // For plain text-based formats, use sync processing.
  // Rich formats with dedicated parsers stay in async path.
  if (
    typeof data === "string" &&
    !["pdf", "word", "excel", "presentation", "epub", "rtf"].includes(type)
  ) {
    return processDocument(id, filename, data, options)
  }

  let content = ""
  let embeddableContent = ""
  let metadata: DocumentMetadata = {
    size: typeof data === "string" ? data.length : data.byteLength,
    lineCount: 0,
    wordCount: 0,
  }
  let parseResult: ProcessedDocument["parseResult"]
  let parseSummary: ParseSummary | undefined
  let parseDiagnostics: ParseDiagnostic[] = []

  switch (type) {
    case "pdf": {
      // Dynamic import to reduce bundle size and memory usage
      const { parsePDF, extractPDFEmbeddableContent } = await import("./parsers/pdf-parser")
      const buffer = typeof data === "string" ? stringToArrayBuffer(data) : data
      const parsed = await parsePDF(buffer)
      content = parsed.text
      embeddableContent = opts.extractEmbeddable ? extractPDFEmbeddableContent(parsed) : content
      metadata = {
        ...metadata,
        title: parsed.metadata.title,
        lineCount: content.split("\n").length,
        wordCount: countWords(content),
        pageCount: parsed.pageCount,
        author: parsed.metadata.author,
      }
      parseResult = parsed
      parseSummary = normalizePDFSummary(parsed)
      if (parsed.diagnostics?.length) {
        parseDiagnostics = [...parsed.diagnostics]
      }
      break
    }

    case "word": {
      try {
        const extension = getFileExtension(filename)
        const buffer = typeof data === "string" ? stringToArrayBuffer(data) : data

        if (extension === "odt") {
          const { parseOpenDocumentText } = await import("./parsers/open-document-parser")
          const parsed = await parseOpenDocumentText(buffer)
          content = parsed.text
          embeddableContent = opts.extractEmbeddable ? content : content
          metadata = {
            ...metadata,
            title: parsed.metadata?.title,
            author: parsed.metadata?.author,
            lineCount: content.split("\n").length,
            wordCount: countWords(content),
            language: "word",
          }
          parseResult = parsed
          parseSummary = normalizeWordSummary(parsed as WordParseResult)
          parseDiagnostics = mapWordMessages((parsed as WordParseResult).messages ?? [])
        } else {
          // Dynamic import to reduce bundle size and memory usage
          const { parseWord, extractWordEmbeddableContent } =
            await import("./parsers/office-parser")
          const parsed = await parseWord(buffer)
          content = parsed.text
          embeddableContent = opts.extractEmbeddable
            ? extractWordEmbeddableContent(parsed)
            : content
          metadata = {
            ...metadata,
            lineCount: content.split("\n").length,
            wordCount: countWords(content),
            language: "word",
          }
          parseResult = parsed
          parseSummary = normalizeWordSummary(parsed)
          parseDiagnostics = mapWordMessages(parsed.messages)
        }
      } catch (error) {
        throw normalizeDocumentParseError("word processing", error)
      }
      break
    }

    case "excel": {
      try {
        const extension = getFileExtension(filename)
        const buffer = typeof data === "string" ? stringToArrayBuffer(data) : data

        if (extension === "ods") {
          const { parseOpenDocumentSpreadsheet } = await import("./parsers/open-document-parser")
          const parsed = await parseOpenDocumentSpreadsheet(buffer)
          content = parsed.text
          embeddableContent = content
          metadata = {
            ...metadata,
            lineCount: content.split("\n").length,
            wordCount: countWords(content),
            language: "excel",
            sheetCount: parsed.sheets.length,
            sheetNames: parsed.sheetNames,
          }
          parseResult = parsed
          parseSummary = normalizeExcelSummary(parsed)
        } else {
          // Dynamic import to reduce bundle size and memory usage
          const { parseExcel, extractExcelEmbeddableContent } =
            await import("./parsers/office-parser")
          const parsed = await parseExcel(buffer)
          content = parsed.text
          embeddableContent = opts.extractEmbeddable
            ? extractExcelEmbeddableContent(parsed)
            : content
          metadata = {
            ...metadata,
            lineCount: content.split("\n").length,
            wordCount: countWords(content),
            language: "excel",
            sheetCount: parsed.sheets.length,
            sheetNames: parsed.sheetNames,
          }
          parseResult = parsed
          parseSummary = normalizeExcelSummary(parsed)
        }
      } catch (error) {
        throw normalizeDocumentParseError("spreadsheet", error)
      }
      break
    }

    case "presentation": {
      const ext = getFileExtension(filename)
      if (ext === "ppt") {
        throw new Error(
          "Legacy PowerPoint (.ppt) is not supported. Please convert to .pptx and retry."
        )
      }

      try {
        const buffer = typeof data === "string" ? stringToArrayBuffer(data) : data

        if (ext === "odp") {
          const { parseOpenDocumentPresentation } = await import("./parsers/open-document-parser")
          const parsed = await parseOpenDocumentPresentation(buffer)
          content = parsed.text
          embeddableContent = content
          metadata = {
            ...metadata,
            title: parsed.metadata.title,
            author: parsed.metadata.author,
            lineCount: content.split("\n").length,
            wordCount: countWords(content),
            language: "presentation",
            slideCount: parsed.slideCount,
          }
          parseResult = parsed
          parseSummary = normalizePresentationSummary(parsed)
        } else {
          const { parsePresentation, extractPresentationEmbeddableContent } =
            await import("./parsers/presentation-parser")
          const parsed = await parsePresentation(buffer)
          content = parsed.text
          embeddableContent = opts.extractEmbeddable
            ? extractPresentationEmbeddableContent(parsed)
            : content
          metadata = {
            ...metadata,
            title: parsed.metadata.title,
            author: parsed.metadata.author,
            lineCount: content.split("\n").length,
            wordCount: countWords(content),
            language: "presentation",
            slideCount: parsed.slideCount,
          }
          parseResult = parsed
          parseSummary = normalizePresentationSummary(parsed)
        }
      } catch (error) {
        throw normalizeDocumentParseError("presentation", error)
      }
      break
    }

    case "rtf": {
      const { parseRTF, extractRTFEmbeddableContent } = await import("./parsers/rtf-parser")
      const text = typeof data === "string" ? data : arrayBufferToString(data)
      const parsed = parseRTF(text)
      content = parsed.text
      embeddableContent = opts.extractEmbeddable ? extractRTFEmbeddableContent(parsed) : content
      metadata = {
        ...metadata,
        lineCount: content.split("\n").length,
        wordCount: countWords(content),
        language: "rtf",
        charset: parsed.metadata.charset,
      }
      parseResult = parsed
      parseSummary = normalizeRTFSummary(parsed)
      break
    }

    case "epub": {
      const { parseEPUB, extractEPUBEmbeddableContent } = await import("./parsers/epub-parser")
      const buffer = typeof data === "string" ? stringToArrayBuffer(data) : data
      const parsed = await parseEPUB(buffer)
      content = parsed.text
      embeddableContent = opts.extractEmbeddable ? extractEPUBEmbeddableContent(parsed) : content
      metadata = {
        ...metadata,
        title: parsed.metadata.title,
        author: parsed.metadata.author,
        lineCount: content.split("\n").length,
        wordCount: countWords(content),
        language: "epub",
        chapterCount: parsed.chapterCount,
      }
      parseResult = parsed
      parseSummary = normalizeEPUBSummary(parsed)
      break
    }

    case "csv": {
      // Dynamic import to reduce bundle size and memory usage
      const { parseCSV, extractCSVEmbeddableContent } = await import("./parsers/csv-parser")
      const text = typeof data === "string" ? data : arrayBufferToString(data)
      const parsed = parseCSV(text)
      content = text
      embeddableContent = opts.extractEmbeddable ? extractCSVEmbeddableContent(parsed) : content
      metadata = {
        ...metadata,
        lineCount: parsed.rowCount,
        wordCount: countWords(content),
        language: "csv",
        rowCount: parsed.rowCount,
        columnCount: parsed.columnCount,
        headers: parsed.headers,
      }
      parseResult = parsed
      parseSummary = normalizeCSVSummary(parsed)
      break
    }

    case "html": {
      // Dynamic import to reduce bundle size and memory usage
      const { parseHTML, extractHTMLEmbeddableContent } = await import("./parsers/html-parser")
      const text = typeof data === "string" ? data : arrayBufferToString(data)
      const parsed = await parseHTML(text)
      content = text
      embeddableContent = opts.extractEmbeddable
        ? extractHTMLEmbeddableContent(parsed)
        : parsed.text
      metadata = {
        ...metadata,
        title: parsed.title,
        lineCount: content.split("\n").length,
        wordCount: countWords(parsed.text),
        language: "html",
        linkCount: parsed.links.length,
        imageCount: parsed.images.length,
      }
      parseResult = parsed
      parseSummary = normalizeHTMLSummary(parsed)
      break
    }

    default: {
      // Only unknown formats should fall back to generic text processing.
      if (type !== "unknown") {
        throw new Error(`No parser is configured for recognized document type '${type}'.`)
      }

      const text = typeof data === "string" ? data : arrayBufferToString(data)
      return processDocument(id, filename, text, options)
    }
  }

  if (parseSummary) {
    metadata = { ...metadata, parseSummary }
  }

  const result: ProcessedDocument = {
    id,
    filename,
    type,
    content,
    embeddableContent,
    metadata,
    parseResult,
    parseSummary,
    parseDiagnostics,
  }

  // Generate chunks if requested
  if (opts.generateChunks) {
    const chunkResult = chunkDocument(embeddableContent, opts.chunkingOptions, id)
    result.chunks = chunkResult.chunks
  }

  return result
}

/**
 * Convert string to ArrayBuffer
 */
function stringToArrayBuffer(str: string): ArrayBuffer {
  const encoder = new TextEncoder()
  return encoder.encode(str).buffer
}

/**
 * Convert ArrayBuffer to string
 */
function arrayBufferToString(buffer: ArrayBuffer): string {
  const decoder = new TextDecoder()
  return decoder.decode(buffer)
}

/**
 * Process multiple documents
 */
export function processDocuments(
  documents: { id: string; filename: string; content: string }[],
  options: ProcessingOptions = {}
): ProcessedDocument[] {
  return documents.map((doc) => processDocument(doc.id, doc.filename, doc.content, options))
}

/**
 * Extract summary from document (first N characters or sentences)
 */
export function extractSummary(content: string, maxLength: number = 200): string {
  const cleaned = content.replace(/\s+/g, " ").trim()

  if (cleaned.length <= maxLength) {
    return cleaned
  }

  // Try to break at sentence boundary
  const truncated = cleaned.slice(0, maxLength)
  const lastPeriod = truncated.lastIndexOf(".")
  const lastQuestion = truncated.lastIndexOf("?")
  const lastExclaim = truncated.lastIndexOf("!")

  const breakPoint = Math.max(lastPeriod, lastQuestion, lastExclaim)

  if (breakPoint > maxLength * 0.5) {
    return truncated.slice(0, breakPoint + 1)
  }

  // Break at word boundary
  const lastSpace = truncated.lastIndexOf(" ")
  if (lastSpace > maxLength * 0.7) {
    return truncated.slice(0, lastSpace) + "..."
  }

  return truncated + "..."
}

/**
 * Get file extension from filename
 */
export function getFileExtension(filename: string): string {
  return getFilenameExtension(filename)
}

/**
 * Check if file is a text-based file that can be processed
 */
export function isTextFile(filename: string): boolean {
  const textExtensions = [
    "txt",
    "md",
    "markdown",
    "mdx",
    "js",
    "jsx",
    "ts",
    "tsx",
    "mjs",
    "cjs",
    "py",
    "rb",
    "java",
    "kt",
    "go",
    "rs",
    "cpp",
    "c",
    "h",
    "hpp",
    "cs",
    "php",
    "swift",
    "scala",
    "r",
    "sql",
    "sh",
    "bash",
    "zsh",
    "ps1",
    "json",
    "yaml",
    "yml",
    "toml",
    "ini",
    "cfg",
    "conf",
    "xml",
    "html",
    "htm",
    "css",
    "scss",
    "less",
    "sass",
    "vue",
    "svelte",
    "rtf",
    "env",
    "gitignore",
    "dockerignore",
    "editorconfig",
    "log",
    "csv",
    "tsv",
  ]

  const ext = getFileExtension(filename)
  return textExtensions.includes(ext) || ext === ""
}

/**
 * Estimate token count for content (CJK-aware approximation)
 * CJK characters typically map to 1-2 tokens each
 * English text averages ~4 characters per token
 * Code tends to have more tokens per character (~3 chars/token)
 */
export function estimateTokenCount(content: string): number {
  if (!content) return 0

  // Count CJK characters (Chinese, Japanese, Korean)
  // CJK Unified Ideographs: U+4E00-U+9FFF
  // CJK Extension A: U+3400-U+4DBF
  // Hiragana: U+3040-U+309F, Katakana: U+30A0-U+30FF
  // Hangul Syllables: U+AC00-U+D7AF
  // Fullwidth forms: U+FF00-U+FFEF
  const cjkRegex = /[\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF\uFF00-\uFFEF]/g
  const cjkMatches = content.match(cjkRegex)
  const cjkCount = cjkMatches ? cjkMatches.length : 0

  // Non-CJK character count
  const nonCjkLength = content.length - cjkCount

  // CJK: ~1.5 tokens per character on average
  // Non-CJK: ~4 characters per token (0.25 tokens/char)
  const cjkTokens = cjkCount * 1.5
  const nonCjkTokens = nonCjkLength / 4

  return Math.ceil(cjkTokens + nonCjkTokens)
}

/**
 * Validate a file before processing
 */
export function validateFile(
  filename: string,
  size: number,
  options: ValidationOptions = {}
): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []
  const maxSize = options.maxFileSize ?? 50 * 1024 * 1024 // 50MB default

  // Check file size
  if (size > maxSize) {
    errors.push(
      `File size (${formatFileSize(size)}) exceeds maximum allowed size (${formatFileSize(maxSize)})`
    )
  } else if (size > maxSize * 0.8) {
    warnings.push(
      `File size (${formatFileSize(size)}) is close to the maximum allowed size (${formatFileSize(maxSize)})`
    )
  }

  if (size === 0) {
    warnings.push("File is empty")
  }

  // Check file type
  const type = detectDocumentType(filename)
  if (type === "unknown") {
    warnings.push(`Unrecognized file type for '${filename}', will be processed as plain text`)
  }

  if (options.allowedTypes && options.allowedTypes.length > 0) {
    if (!options.allowedTypes.includes(type)) {
      errors.push(
        `File type '${type}' is not allowed. Allowed types: ${options.allowedTypes.join(", ")}`
      )
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  }
}

/**
 * Format file size for display
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

/**
 * Detect BOM encoding from ArrayBuffer
 * Returns encoding name or 'utf-8' as default
 */
export function detectEncoding(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)

  // UTF-8 BOM: EF BB BF
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return "utf-8"
  }

  // UTF-16 LE BOM: FF FE
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return "utf-16le"
  }

  // UTF-16 BE BOM: FE FF
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return "utf-16be"
  }

  // UTF-32 LE BOM: FF FE 00 00
  if (
    bytes.length >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xfe &&
    bytes[2] === 0x00 &&
    bytes[3] === 0x00
  ) {
    return "utf-32le"
  }

  // Default to UTF-8
  return "utf-8"
}

/**
 * Compare two processed documents and return differences
 */
export function compareDocuments(docA: ProcessedDocument, docB: ProcessedDocument): DocumentDiff {
  const linesA = docA.content.split("\n")
  const linesB = docB.content.split("\n")

  const added: string[] = []
  const removed: string[] = []
  const modified: { line: number; before: string; after: string }[] = []

  // Simple line-by-line diff
  const setA = new Set(linesA.map((l) => l.trim()).filter((l) => l.length > 0))
  const setB = new Set(linesB.map((l) => l.trim()).filter((l) => l.length > 0))

  // Lines in B but not in A (added)
  for (const line of setB) {
    if (!setA.has(line)) {
      added.push(line)
    }
  }

  // Lines in A but not in B (removed)
  for (const line of setA) {
    if (!setB.has(line)) {
      removed.push(line)
    }
  }

  // Line-by-line comparison for modifications
  const maxLines = Math.min(linesA.length, linesB.length)
  for (let i = 0; i < maxLines; i++) {
    const lineA = linesA[i].trim()
    const lineB = linesB[i].trim()
    if (lineA !== lineB && lineA.length > 0 && lineB.length > 0) {
      // Check if it's a modification (similar but not identical)
      const similarity = computeLineSimilarity(lineA, lineB)
      if (similarity > 0.3 && similarity < 1.0) {
        modified.push({ line: i + 1, before: lineA, after: lineB })
      }
    }
  }

  // Compute overall similarity using Jaccard coefficient on non-empty lines
  const intersection = [...setA].filter((line) => setB.has(line)).length
  const union = new Set([...setA, ...setB]).size
  const similarity = union > 0 ? intersection / union : 1.0

  return { added, removed, modified, similarity }
}

/**
 * Compute similarity between two strings (0-1) using bigram overlap
 */
function computeLineSimilarity(a: string, b: string): number {
  if (a === b) return 1.0
  if (a.length === 0 || b.length === 0) return 0

  const bigramsA = new Set<string>()
  const bigramsB = new Set<string>()

  for (let i = 0; i < a.length - 1; i++) bigramsA.add(a.substring(i, i + 2))
  for (let i = 0; i < b.length - 1; i++) bigramsB.add(b.substring(i, i + 2))

  let intersection = 0
  for (const bg of bigramsA) {
    if (bigramsB.has(bg)) intersection++
  }

  const union = bigramsA.size + bigramsB.size - intersection
  return union > 0 ? intersection / union : 0
}

/**
 * Check if a document type is a binary format requiring async processing
 */
export function isBinaryType(type: DocumentType): boolean {
  return isBinaryDocumentType(type)
}
