/**
 * Office Parser - Extract content from Word (.docx) and Excel (.xlsx) files
 * Uses mammoth for Word and xlsx for Excel
 * Enhanced with image extraction, metadata, style mapping, date/merged cell/formula support
 */

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

export interface ExcelCell {
  value: string | number | boolean | null
  type: "string" | "number" | "boolean" | "date" | "empty"
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

/**
 * Parse Word document from ArrayBuffer
 */
export async function parseWord(
  data: ArrayBuffer,
  options: WordParseOptions = {}
): Promise<WordParseResult> {
  const mammoth = await import("mammoth")

  const convertOptions: Record<string, unknown> = {}

  // Image extraction via convertImage callback
  const extractedImages: WordImage[] = []
  if (options.extractImages !== false) {
    convertOptions.convertImage = mammoth.default.images.imgElement(
      (image: { read: (encoding: string) => Promise<string>; contentType: string }) => {
        return image.read("base64").then((imageBase64: string) => {
          extractedImages.push({
            contentType: image.contentType,
            base64: imageBase64,
          })
          return { src: `data:${image.contentType};base64,${imageBase64}` }
        })
      }
    )
  }

  // Style mapping for better HTML output
  if (options.styleMap && options.styleMap.length > 0) {
    convertOptions.styleMap = options.styleMap
  }

  const result = await mammoth.default.convertToHtml({ arrayBuffer: data }, convertOptions)
  const textResult = await mammoth.default.extractRawText({ arrayBuffer: data })

  const messages: WordMessage[] = result.messages.map((msg) => ({
    type: msg.type as "warning" | "error",
    message: msg.message,
  }))

  // Extract headings from HTML
  const headings = extractHeadingsFromHtml(result.value)

  // Extract metadata from docx (it's a ZIP containing XML)
  let metadata: WordMetadata | undefined
  if (options.extractMetadata !== false) {
    metadata = await extractWordMetadata(data)
  }

  return {
    text: textResult.value,
    html: result.value,
    messages,
    images: extractedImages,
    metadata,
    headings,
  }
}

/**
 * Extract headings from mammoth-generated HTML
 */
function extractHeadingsFromHtml(html: string): WordHeading[] {
  const headings: WordHeading[] = []
  const headingRegex = /<h([1-6])[^>]*>(.*?)<\/h[1-6]>/gi
  let match

  while ((match = headingRegex.exec(html)) !== null) {
    const level = parseInt(match[1], 10)
    // Strip HTML tags from heading text
    const text = match[2].replace(/<[^>]*>/g, "").trim()
    if (text) {
      headings.push({ level, text })
    }
  }

  return headings
}

/**
 * Extract metadata from Word docx file (ZIP containing XML)
 */
async function extractWordMetadata(data: ArrayBuffer): Promise<WordMetadata | undefined> {
  try {
    // docx is a ZIP file; we need to read docProps/core.xml
    // Use a minimal approach: find the core.xml within the ZIP
    const uint8 = new Uint8Array(data)
    const decoder = new TextDecoder("utf-8")

    // Search for core.xml content in the ZIP
    // The docProps/core.xml contains Dublin Core metadata
    const fullText = decoder.decode(uint8)
    const coreXmlMatch =
      fullText.match(/<cp:coreProperties[\s\S]*?<\/cp:coreProperties>/i) ||
      fullText.match(/<coreProperties[\s\S]*?<\/coreProperties>/i)

    if (!coreXmlMatch) return undefined

    const coreXml = coreXmlMatch[0]

    const getTag = (xml: string, tag: string): string | undefined => {
      const regex = new RegExp(`<(?:\\w+:)?${tag}[^>]*>([\\s\\S]*?)<\/(?:\\w+:)?${tag}>`, "i")
      const m = xml.match(regex)
      return m ? m[1].trim() : undefined
    }

    const parseXmlDate = (dateStr?: string): Date | undefined => {
      if (!dateStr) return undefined
      const d = new Date(dateStr)
      return isNaN(d.getTime()) ? undefined : d
    }

    return {
      title: getTag(coreXml, "title"),
      author: getTag(coreXml, "creator"),
      lastModifiedBy: getTag(coreXml, "lastModifiedBy"),
      description: getTag(coreXml, "description"),
      subject: getTag(coreXml, "subject"),
      keywords: getTag(coreXml, "keywords"),
      created: parseXmlDate(getTag(coreXml, "created")),
      modified: parseXmlDate(getTag(coreXml, "modified")),
      revision: getTag(coreXml, "revision")
        ? parseInt(getTag(coreXml, "revision")!, 10)
        : undefined,
    }
  } catch {
    return undefined
  }
}

/**
 * Parse Word document from File object
 */
export async function parseWordFile(
  file: File,
  options: WordParseOptions = {}
): Promise<WordParseResult> {
  const buffer = await file.arrayBuffer()
  return parseWord(buffer, options)
}

/**
 * Parse Excel file from ArrayBuffer
 */
export async function parseExcel(
  data: ArrayBuffer,
  options: ExcelParseOptions = {}
): Promise<ExcelParseResult> {
  const XLSX = await import("xlsx")

  const readOptions: Record<string, unknown> = { type: "array" }
  if (options.cellDates) {
    readOptions.cellDates = true
  }
  if (options.cellFormula) {
    readOptions.cellFormula = true
  }

  const workbook = XLSX.read(data, readOptions)
  const sheets: ExcelSheet[] = []
  const textParts: string[] = []
  const allStats: ExcelSheetStats[] = []

  const sheetsToProcess =
    options.sheetFilter && options.sheetFilter.length > 0
      ? workbook.SheetNames.filter((name) => options.sheetFilter!.includes(name))
      : workbook.SheetNames

  for (const sheetName of sheetsToProcess) {
    const worksheet = workbook.Sheets[sheetName]

    // Convert to JSON array
    const jsonData = XLSX.utils.sheet_to_json<(string | number | boolean | null)[]>(worksheet, {
      header: 1,
      defval: null,
      rawNumbers: !options.cellDates,
    })

    // Apply maxRows limit if specified
    const limitedData =
      options.maxRows && options.maxRows > 0 ? jsonData.slice(0, options.maxRows) : jsonData

    // Calculate dimensions
    const rowCount = limitedData.length
    const columnCount = limitedData.reduce((max, row) => Math.max(max, row.length), 0)

    // Extract merged cells
    const merges = worksheet["!merges"] || []
    const mergedCells = merges.map(
      (merge: { s: { c: number; r: number }; e: { c: number; r: number } }) => {
        const startCol = XLSX.utils.encode_col(merge.s.c)
        const endCol = XLSX.utils.encode_col(merge.e.c)
        return `${startCol}${merge.s.r + 1}:${endCol}${merge.e.r + 1}`
      }
    )

    sheets.push({
      name: sheetName,
      data: limitedData,
      rowCount,
      columnCount,
      mergedCells: mergedCells.length > 0 ? mergedCells : undefined,
    })

    // Compute sheet statistics
    const stats = computeSheetStats(sheetName, limitedData, columnCount, mergedCells)
    allStats.push(stats)

    // Convert to text for embedding
    const sheetText = convertSheetToText(sheetName, limitedData, mergedCells)
    textParts.push(sheetText)
  }

  return {
    text: textParts.join("\n\n"),
    sheets,
    sheetNames: workbook.SheetNames,
    sheetStats: allStats.length > 0 ? allStats : undefined,
  }
}

/**
 * Compute statistics for an Excel sheet
 */
function computeSheetStats(
  name: string,
  data: (string | number | boolean | null)[][],
  columnCount: number,
  mergedCells: string[]
): ExcelSheetStats {
  let totalCells = 0
  let emptyCells = 0
  const colTypeCounts: Record<number, Record<string, number>> = {}

  for (const row of data) {
    for (let col = 0; col < columnCount; col++) {
      totalCells++
      const val = col < row.length ? row[col] : null

      if (val === null || val === undefined || val === "") {
        emptyCells++
        continue
      }

      if (!colTypeCounts[col]) colTypeCounts[col] = {}

      let cellType: string
      if (typeof val === "object" && val !== null && "getTime" in val) {
        cellType = "date"
      } else if (typeof val === "number") {
        cellType = "number"
      } else if (typeof val === "boolean") {
        cellType = "boolean"
      } else {
        // Check if string looks like a date
        const strVal = String(val)
        if (/^\d{4}-\d{2}-\d{2}/.test(strVal) && !isNaN(Date.parse(strVal))) {
          cellType = "date"
        } else {
          cellType = "string"
        }
      }

      colTypeCounts[col][cellType] = (colTypeCounts[col][cellType] || 0) + 1
    }
  }

  const columnTypes: Record<number, "string" | "number" | "date" | "boolean" | "mixed"> = {}
  for (const [col, types] of Object.entries(colTypeCounts)) {
    const typeEntries = Object.entries(types)
    if (typeEntries.length === 1) {
      columnTypes[Number(col)] = typeEntries[0][0] as "string" | "number" | "date" | "boolean"
    } else {
      columnTypes[Number(col)] = "mixed"
    }
  }

  return {
    name,
    rowCount: data.length,
    columnCount,
    mergedCellCount: mergedCells.length,
    emptyRate: totalCells > 0 ? emptyCells / totalCells : 0,
    columnTypes,
  }
}

/**
 * Parse Excel file from File object
 */
export async function parseExcelFile(
  file: File,
  options: ExcelParseOptions = {}
): Promise<ExcelParseResult> {
  const buffer = await file.arrayBuffer()
  return parseExcel(buffer, options)
}

/**
 * Convert Excel sheet data to readable text
 */
function convertSheetToText(
  sheetName: string,
  data: (string | number | boolean | null)[][],
  mergedCells?: string[]
): string {
  const lines: string[] = [`## Sheet: ${sheetName}`]

  if (data.length === 0) {
    lines.push("(empty sheet)")
    return lines.join("\n")
  }

  // Note merged cells if present
  if (mergedCells && mergedCells.length > 0) {
    lines.push(`Merged cells: ${mergedCells.join(", ")}`)
  }

  // Use first row as header if it looks like headers
  const hasHeader = data.length > 1 && data[0].every((cell) => typeof cell === "string")

  if (hasHeader) {
    const headers = data[0] as string[]
    lines.push(headers.join(" | "))
    lines.push(headers.map(() => "---").join(" | "))

    for (let i = 1; i < data.length; i++) {
      const row = data[i]
      const cells = row.map((cell) => formatCellValue(cell))
      lines.push(cells.join(" | "))
    }
  } else {
    // No header, just convert rows
    for (const row of data) {
      const cells = row.map((cell) => formatCellValue(cell))
      lines.push(cells.join(" | "))
    }
  }

  return lines.join("\n")
}

/**
 * Format cell value for text output
 */
function formatCellValue(value: string | number | boolean | null): string {
  if (value === null || value === undefined) {
    return ""
  }
  if (typeof value === "boolean") {
    return value ? "TRUE" : "FALSE"
  }
  if (typeof value === "number") {
    // Format numbers with reasonable precision
    if (Number.isInteger(value)) {
      return value.toString()
    }
    return value.toFixed(2)
  }
  return String(value)
}

/**
 * Extract embeddable content from Word document
 */
export function extractWordEmbeddableContent(result: WordParseResult): string {
  const parts: string[] = []

  if (result.metadata?.title) {
    parts.push(`Title: ${result.metadata.title}`)
  }
  if (result.metadata?.author) {
    parts.push(`Author: ${result.metadata.author}`)
  }

  // Include heading structure for context
  if (result.headings && result.headings.length > 0) {
    parts.push("Document Structure:")
    parts.push(
      result.headings
        .map((h) => `${"  ".repeat(h.level - 1)}${"#".repeat(h.level)} ${h.text}`)
        .join("\n")
    )
  }

  parts.push(result.text)

  return parts.join("\n\n")
}

/**
 * Extract embeddable content from Excel file
 */
export function extractExcelEmbeddableContent(result: ExcelParseResult): string {
  const parts: string[] = []

  // Include sheet statistics summary
  if (result.sheetStats && result.sheetStats.length > 0) {
    const summary = result.sheetStats
      .map(
        (s) =>
          `${s.name}: ${s.rowCount} rows × ${s.columnCount} cols` +
          (s.mergedCellCount > 0 ? `, ${s.mergedCellCount} merged` : "")
      )
      .join("; ")
    parts.push(`Sheets: ${summary}`)
  }

  parts.push(result.text)

  return parts.join("\n\n")
}

/**
 * Detect Office file type from extension
 */
export function detectOfficeType(filename: string): "word" | "excel" | "unknown" {
  const ext = filename.split(".").pop()?.toLowerCase() || ""

  if (["docx", "doc", "docm", "odt"].includes(ext)) {
    return "word"
  }
  if (["xlsx", "xls", "xlsm", "ods"].includes(ext)) {
    return "excel"
  }

  return "unknown"
}
