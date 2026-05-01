/**
 * Document Management Types
 */

export type DocumentType =
  | "markdown"
  | "code"
  | "text"
  | "json"
  | "pdf"
  | "word"
  | "excel"
  | "csv"
  | "html"
  | "rtf"
  | "epub"
  | "presentation"
  | "unknown"

export interface DocumentMetadata {
  title?: string
  language?: string
  size: number
  lineCount: number
  wordCount: number
  createdAt?: Date
  modifiedAt?: Date
  tags?: string[]
  [key: string]: unknown
}

export interface ProcessedDocument {
  id: string
  filename: string
  type: DocumentType
  content: string
  embeddableContent: string
  metadata: DocumentMetadata
  chunks?: DocumentChunk[]
  parseResult?:
    | PDFParseResult
    | WordParseResult
    | ExcelParseResult
    | CSVParseResult
    | HTMLParseResult
    | PresentationParseResult
    | RTFParseResult
    | EPUBParseResult
  parseSummary?: ParseSummary
  parseDiagnostics?: ParseDiagnostic[]
}

export interface DocumentChunk {
  id: string
  content: string
  index: number
  startOffset: number
  endOffset: number
  metadata?: Record<string, unknown>
}

export interface StoredDocument {
  id: string
  filename: string
  type: DocumentType
  content: string
  embeddableContent?: string
  metadata: DocumentMetadata
  projectId?: string
  collectionId?: string
  isIndexed: boolean
  version: number
  createdAt: Date
  updatedAt: Date
}

export interface DocumentVersion {
  id: string
  documentId: string
  version: number
  content: string
  createdAt: Date
  createdBy?: string
}

export interface DocumentFilter {
  type?: DocumentType
  projectId?: string
  collectionId?: string
  isIndexed?: boolean
  searchQuery?: string
}

// Markdown Parser Types
export interface MarkdownSection {
  level: number
  title: string
  content: string
  startLine: number
  endLine: number
}

export interface MarkdownParseResult {
  title?: string
  content: string
  sections: MarkdownSection[]
  frontmatter?: Record<string, unknown>
  links: { text: string; url: string }[]
  codeBlocks: { language: string; code: string }[]
  images: { alt: string; url: string }[]
  taskLists: TaskItem[]
  mathBlocks: MathBlock[]
  footnotes: Footnote[]
  admonitions: Admonition[]
}

export interface TaskItem {
  text: string
  checked: boolean
  line: number
}

export interface MathBlock {
  content: string
  displayMode: boolean
  line: number
}

export interface Footnote {
  id: string
  content: string
}

export type AdmonitionType =
  | "note"
  | "tip"
  | "warning"
  | "caution"
  | "important"
  | "info"
  | "danger"
  | "abstract"

export interface Admonition {
  type: AdmonitionType
  title?: string
  content: string
}

// Code Parser Types
export interface CodeFunction {
  name: string
  startLine: number
  endLine: number
  signature: string
  docstring?: string
}

export interface CodeClass {
  name: string
  startLine: number
  endLine: number
  methods: CodeFunction[]
  docstring?: string
}

export interface CodeImport {
  module: string
  items?: string[]
  line: number
}

export interface CodeParseResult {
  language: string
  imports: CodeImport[]
  functions: CodeFunction[]
  classes: CodeClass[]
  comments: string[]
  content: string
}

// PDF Parser Types
export interface PDFParseResult {
  text: string
  pageCount: number
  pages: PDFPage[]
  metadata: PDFMetadata
  outline?: PDFOutlineItem[]
  annotations?: PDFAnnotation[]
}

export interface PDFPage {
  pageNumber: number
  text: string
  width: number
  height: number
}

export interface PDFMetadata {
  title?: string
  author?: string
  subject?: string
  keywords?: string
  creator?: string
  producer?: string
  creationDate?: Date
  modificationDate?: Date
}

export interface PDFParseOptions {
  password?: string
  startPage?: number
  endPage?: number
  extractOutline?: boolean
  extractAnnotations?: boolean
}

export interface PDFOutlineItem {
  title: string
  pageNumber?: number
  children: PDFOutlineItem[]
}

export interface PDFAnnotation {
  type: string
  content: string
  pageNumber: number
  rect?: { x: number; y: number; width: number; height: number }
}

// Office Parser Types
export interface WordParseResult {
  text: string
  html: string
  messages: WordMessage[]
  images: WordImage[]
  metadata?: WordMetadata
  headings?: WordHeading[]
}

export interface WordMessage {
  type: "warning" | "error"
  message: string
}

export interface WordImage {
  contentType: string
  base64: string
}

export interface WordMetadata {
  title?: string
  author?: string
  lastModifiedBy?: string
  created?: Date
  modified?: Date
  revision?: number
  description?: string
  subject?: string
  keywords?: string
}

export interface WordHeading {
  level: number
  text: string
}

export interface WordParseOptions {
  extractImages?: boolean
  styleMap?: string[]
  extractMetadata?: boolean
}

export interface ExcelParseResult {
  text: string
  sheets: ExcelSheet[]
  sheetNames: string[]
  sheetStats?: ExcelSheetStats[]
}

export interface ExcelSheet {
  name: string
  data: (string | number | boolean | null)[][]
  rowCount: number
  columnCount: number
  mergedCells?: string[]
}

export interface ExcelParseOptions {
  cellDates?: boolean
  cellFormula?: boolean
  sheetFilter?: string[]
  maxRows?: number
}

export interface ExcelSheetStats {
  name: string
  rowCount: number
  columnCount: number
  mergedCellCount: number
  emptyRate: number
  columnTypes: Record<number, "string" | "number" | "date" | "boolean" | "mixed">
}

// CSV Parser Types
export interface CSVParseResult {
  text: string
  data: string[][]
  headers: string[]
  rowCount: number
  columnCount: number
  delimiter: string
}

export interface CSVParseOptions {
  delimiter?: string
  hasHeader?: boolean
  skipEmptyLines?: boolean
  trimValues?: boolean
  encoding?: string
}

export type ColumnType = "string" | "number" | "date" | "boolean" | "mixed" | "empty"

export interface ColumnTypeInfo {
  columnIndex: number
  columnName: string
  inferredType: ColumnType
  sampleValues: string[]
  nullCount: number
  uniqueCount: number
}

export interface ColumnStats {
  columnIndex: number
  columnName: string
  type: ColumnType
  count: number
  nullCount: number
  uniqueCount: number
  min?: number
  max?: number
  mean?: number
  median?: number
}

// HTML Parser Types
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

// Presentation Parser Types
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

// RTF Parser Types
export interface RTFParseResult {
  text: string
  metadata: RTFMetadata
}

export interface RTFMetadata {
  charset?: string
  controlWordCount: number
}

// EPUB Parser Types
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

// Parse Summary Types
export type ParseSummaryParser =
  | "markdown"
  | "code"
  | "json"
  | "text"
  | "pdf"
  | "word"
  | "excel"
  | "csv"
  | "html"
  | "rtf"
  | "epub"
  | "presentation"

export interface ParseSummarySegment {
  kind: "heading" | "slide" | "chapter" | "sheet" | "page" | "section" | "table" | "code-block"
  index: number
  title?: string
  level?: number
}

export type ParseQualityStatus = "complete" | "degraded" | "partial"

export interface ParseSummaryQuality {
  status: ParseQualityStatus
  reason?: string
}

export interface ParseSummaryStructure {
  segmentCount?: number
  headingCount?: number
  sectionCount?: number
  slideCount?: number
  pageCount?: number
  chapterCount?: number
  sheetCount?: number
  tableCount?: number
  imageCount?: number
  linkCount?: number
  codeBlockCount?: number
}

export interface ParseSummary {
  parser: ParseSummaryParser
  structure: ParseSummaryStructure
  segments?: ParseSummarySegment[]
  quality: ParseSummaryQuality
}

// Parse Diagnostic Types
export type ParseDiagnosticSeverity = "info" | "warning" | "error"

export type ParseDiagnosticCode =
  | "parser_warning"
  | "parser_info"
  | "parse_failed"
  | "password_protected"
  | "legacy_format"
  | "empty_content"
  | "content_truncated"
  | "unsupported_feature"

export interface ParseDiagnostic {
  code: ParseDiagnosticCode
  severity: ParseDiagnosticSeverity
  message: string
  suggestion?: string
}
