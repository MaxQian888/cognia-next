/**
 * Document Formatting Types
 * Comprehensive types for Word document generation with full formatting support
 */

// Page Size definitions (in mm)
export type PageSize = "a4" | "a3" | "a5" | "letter" | "legal" | "custom"
export type PageOrientation = "portrait" | "landscape"

export interface PageDimensions {
  width: number // in mm
  height: number // in mm
}

export const PAGE_SIZES: Record<PageSize, PageDimensions> = {
  a4: { width: 210, height: 297 },
  a3: { width: 297, height: 420 },
  a5: { width: 148, height: 210 },
  letter: { width: 216, height: 279 },
  legal: { width: 216, height: 356 },
  custom: { width: 210, height: 297 },
}

// Margin definitions
export interface PageMargins {
  top: number // in mm
  bottom: number // in mm
  left: number // in mm
  right: number // in mm
  header?: number // header distance from edge
  footer?: number // footer distance from edge
  gutter?: number // gutter margin for binding
}

export const MARGIN_PRESETS: Record<string, PageMargins> = {
  normal: { top: 25.4, bottom: 25.4, left: 25.4, right: 25.4 },
  narrow: { top: 12.7, bottom: 12.7, left: 12.7, right: 12.7 },
  moderate: { top: 25.4, bottom: 25.4, left: 19.1, right: 19.1 },
  wide: { top: 25.4, bottom: 25.4, left: 50.8, right: 50.8 },
  mirrored: { top: 25.4, bottom: 25.4, left: 31.75, right: 25.4, gutter: 12.7 },
}

// Font settings
export interface FontSettings {
  name: string
  size: number // in points
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  color?: string // hex color
  highlight?: string // highlight color
}

export const FONT_FAMILIES = [
  "Arial",
  "Times New Roman",
  "Calibri",
  "Cambria",
  "Georgia",
  "Verdana",
  "Tahoma",
  "Trebuchet MS",
  "Segoe UI",
  "Roboto",
  "Open Sans",
  "Source Sans Pro",
  "Microsoft YaHei",
  "SimSun",
  "SimHei",
  "KaiTi",
  "FangSong",
] as const

export const FONT_SIZES = [
  8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72,
] as const

// Paragraph settings
export type TextAlignment = "left" | "center" | "right" | "justify"
export type LineSpacingRule = "auto" | "atLeast" | "exact" | "multiple"

export interface ParagraphSettings {
  alignment?: TextAlignment
  lineSpacing?: number // in lines (1, 1.5, 2) or points
  lineSpacingRule?: LineSpacingRule
  spaceBefore?: number // space before paragraph in points
  spaceAfter?: number // space after paragraph in points
  firstLineIndent?: number // first line indent in mm
  leftIndent?: number // left indent in mm
  rightIndent?: number // right indent in mm
}

// List settings
export type ListType = "bullet" | "number" | "letter" | "roman"
export type BulletStyle = "disc" | "circle" | "square" | "dash" | "arrow"
export type NumberFormat = "decimal" | "lowerLetter" | "upperLetter" | "lowerRoman" | "upperRoman"

export interface ListSettings {
  type: ListType
  bulletStyle?: BulletStyle
  numberFormat?: NumberFormat
  startNumber?: number
  indentLevel?: number
}

// Header and Footer
export interface HeaderFooterContent {
  left?: string
  center?: string
  right?: string
}

export interface HeaderFooterSettings {
  content: HeaderFooterContent
  font?: Partial<FontSettings>
  showPageNumber?: boolean
  pageNumberFormat?: "decimal" | "roman" | "romanLower"
  differentFirstPage?: boolean
  differentOddEven?: boolean
}

// Table styles
export type TableBorderStyle = "none" | "single" | "double" | "dotted" | "dashed" | "thick"

export interface TableBorder {
  style: TableBorderStyle
  width: number // in points
  color: string // hex color
}

export interface TableCellStyle {
  backgroundColor?: string
  verticalAlign?: "top" | "center" | "bottom"
  padding?: {
    top: number
    bottom: number
    left: number
    right: number
  }
}

export interface TableStyle {
  borders?: {
    top?: TableBorder
    bottom?: TableBorder
    left?: TableBorder
    right?: TableBorder
    insideH?: TableBorder
    insideV?: TableBorder
  }
  headerRow?: TableCellStyle
  oddRows?: TableCellStyle
  evenRows?: TableCellStyle
  width?: number | "auto" | "100%"
}

// Document Styles (Word Styles)
export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6

export interface StyleDefinition {
  id: string
  name: string
  basedOn?: string
  font?: Partial<FontSettings>
  paragraph?: Partial<ParagraphSettings>
}

export interface DocumentStyles {
  title?: StyleDefinition
  heading1?: StyleDefinition
  heading2?: StyleDefinition
  heading3?: StyleDefinition
  heading4?: StyleDefinition
  heading5?: StyleDefinition
  heading6?: StyleDefinition
  normal?: StyleDefinition
  quote?: StyleDefinition
  codeBlock?: StyleDefinition
  listParagraph?: StyleDefinition
  caption?: StyleDefinition
  tocHeading?: StyleDefinition
}

// Default styles
export const DEFAULT_STYLES: DocumentStyles = {
  title: {
    id: "Title",
    name: "Title",
    font: { name: "Calibri", size: 26, bold: true, color: "2F5496" },
    paragraph: { alignment: "center", spaceAfter: 12 },
  },
  heading1: {
    id: "Heading1",
    name: "Heading 1",
    font: { name: "Calibri", size: 16, bold: true, color: "2F5496" },
    paragraph: { spaceBefore: 12, spaceAfter: 6 },
  },
  heading2: {
    id: "Heading2",
    name: "Heading 2",
    font: { name: "Calibri", size: 14, bold: true, color: "2F5496" },
    paragraph: { spaceBefore: 10, spaceAfter: 4 },
  },
  heading3: {
    id: "Heading3",
    name: "Heading 3",
    font: { name: "Calibri", size: 12, bold: true, color: "1F3763" },
    paragraph: { spaceBefore: 8, spaceAfter: 4 },
  },
  normal: {
    id: "Normal",
    name: "Normal",
    font: { name: "Calibri", size: 11 },
    paragraph: { lineSpacing: 1.15, spaceAfter: 8 },
  },
  quote: {
    id: "Quote",
    name: "Quote",
    font: { name: "Calibri", size: 11, italic: true, color: "404040" },
    paragraph: { leftIndent: 10, rightIndent: 10, spaceBefore: 6, spaceAfter: 6 },
  },
  codeBlock: {
    id: "CodeBlock",
    name: "Code Block",
    font: { name: "Consolas", size: 10 },
    paragraph: { spaceBefore: 6, spaceAfter: 6 },
  },
}

// Section settings (for multi-section documents)
export interface SectionSettings {
  pageSize?: PageSize
  orientation?: PageOrientation
  margins?: PageMargins
  columns?: number
  columnSpacing?: number
  sectionBreak?: "continuous" | "nextPage" | "evenPage" | "oddPage"
}

// Table of Contents settings
export interface TableOfContentsSettings {
  enabled: boolean
  title?: string
  levels?: number // 1-9, how many heading levels to include
  showPageNumbers?: boolean
  rightAlignPageNumbers?: boolean
  tabLeader?: "none" | "dot" | "hyphen" | "underscore"
}

// Complete Word Export Options
export interface WordDocumentOptions {
  // Document metadata
  title?: string
  author?: string
  subject?: string
  keywords?: string[]
  description?: string

  // Page setup
  pageSize?: PageSize
  customPageSize?: PageDimensions
  orientation?: PageOrientation
  margins?: PageMargins

  // Default font
  defaultFont?: Partial<FontSettings>

  // Default paragraph
  defaultParagraph?: Partial<ParagraphSettings>

  // Styles
  styles?: Partial<DocumentStyles>

  // Header/Footer
  header?: HeaderFooterSettings
  footer?: HeaderFooterSettings

  // Table of Contents
  tableOfContents?: TableOfContentsSettings

  // Table style
  tableStyle?: TableStyle

  // Content options
  includeMetadata?: boolean
  includeTimestamps?: boolean
  includeTokens?: boolean
  showThinkingProcess?: boolean
  showToolCalls?: boolean
  includeCoverPage?: boolean

  // Theme
  theme?: "light" | "dark"
}

// Default document options
export const DEFAULT_DOCUMENT_OPTIONS: WordDocumentOptions = {
  pageSize: "a4",
  orientation: "portrait",
  margins: MARGIN_PRESETS.normal,
  defaultFont: {
    name: "Calibri",
    size: 11,
  },
  defaultParagraph: {
    lineSpacing: 1.15,
    spaceAfter: 8,
  },
  styles: DEFAULT_STYLES,
  includeMetadata: true,
  includeTimestamps: true,
  includeTokens: false,
  showThinkingProcess: true,
  showToolCalls: true,
  includeCoverPage: true,
  theme: "light",
}

// Document content block types
export type DocumentBlockType =
  | "paragraph"
  | "heading"
  | "list"
  | "table"
  | "image"
  | "codeBlock"
  | "quote"
  | "pageBreak"
  | "sectionBreak"
  | "horizontalRule"

export interface DocumentBlock {
  type: DocumentBlockType
  content?: string
  children?: DocumentBlock[]
}

export interface ParagraphBlock extends DocumentBlock {
  type: "paragraph"
  content: string
  style?: Partial<ParagraphSettings>
  font?: Partial<FontSettings>
}

export interface HeadingBlock extends DocumentBlock {
  type: "heading"
  content: string
  level: HeadingLevel
}

export interface ListBlock extends DocumentBlock {
  type: "list"
  items: string[]
  settings: ListSettings
}

export interface TableBlock extends DocumentBlock {
  type: "table"
  headers: string[]
  rows: string[][]
  style?: TableStyle
}

export interface ImageBlock extends DocumentBlock {
  type: "image"
  src: string // base64 or URL
  alt?: string
  width?: number
  height?: number
  alignment?: TextAlignment
}

export interface CodeBlockBlock extends DocumentBlock {
  type: "codeBlock"
  content: string
  language?: string
}

export interface QuoteBlock extends DocumentBlock {
  type: "quote"
  content: string
  citation?: string
}

export interface PageBreakBlock extends DocumentBlock {
  type: "pageBreak"
}

export interface HorizontalRuleBlock extends DocumentBlock {
  type: "horizontalRule"
}

// Rich Document structure for advanced editing
export interface RichDocument {
  id: string
  title: string
  options: WordDocumentOptions
  sections: DocumentSection[]
  createdAt: Date
  updatedAt: Date
}

export interface DocumentSection {
  id: string
  settings?: SectionSettings
  blocks: DocumentBlock[]
}

// Document template
export interface DocumentTemplate {
  id: string
  name: string
  description: string
  category: "general" | "report" | "letter" | "article" | "presentation" | "custom"
  thumbnail?: string
  options: WordDocumentOptions
  sections: DocumentSection[]
}
