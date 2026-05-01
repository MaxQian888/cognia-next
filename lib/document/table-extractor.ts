/**
 * Table Extractor - Extract and parse tables from various formats
 * Supports Markdown, HTML, and message content
 */

// TableData is inlined here (mirrors `lib/export/document/excel-export.ts`
// in Cognia). cognia-next does not yet host the Excel export module, so we
// keep the structural contract local — `extractedTableToTableData` is the
// only consumer in this file, and downstream callers in cognia-next assert
// on this same shape.
export interface TableData {
  headers: string[]
  rows: (string | number | boolean | null | undefined)[][]
  title?: string
}

export interface ExtractedTable {
  headers: string[]
  rows: string[][]
  title?: string
  sourceType: "markdown" | "html" | "text"
  startIndex: number
  endIndex: number
}

export interface TableExtractionResult {
  tables: ExtractedTable[]
  hasTable: boolean
  tableCount: number
}

/**
 * Extract all tables from content (auto-detect format)
 */
export function extractTables(content: string): TableExtractionResult {
  const markdownTables = extractMarkdownTables(content)
  const htmlTables = extractHTMLTables(content)

  const tables = [...markdownTables, ...htmlTables]

  return {
    tables,
    hasTable: tables.length > 0,
    tableCount: tables.length,
  }
}

/**
 * Extract Markdown tables from content
 */
export function extractMarkdownTables(content: string): ExtractedTable[] {
  const tables: ExtractedTable[] = []
  const lines = content.split("\n")

  let tableStart = -1
  let tableLines: string[] = []
  let inTable = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()

    // Check if line is a table row (starts and ends with |)
    const isTableRow = line.startsWith("|") && line.endsWith("|")
    // Check if it's a separator row (contains only |, -, :, and spaces)
    const isSeparatorRow = /^\|[\s\-:|]+\|$/.test(line)

    if (isTableRow || isSeparatorRow) {
      if (!inTable) {
        inTable = true
        tableStart = i
        tableLines = []
      }
      tableLines.push(line)
    } else if (inTable) {
      // End of table
      const table = parseMarkdownTableLines(tableLines, tableStart, i - 1)
      if (table) {
        tables.push(table)
      }
      inTable = false
      tableLines = []
    }
  }

  // Handle table at end of content
  if (inTable && tableLines.length > 0) {
    const table = parseMarkdownTableLines(tableLines, tableStart, lines.length - 1)
    if (table) {
      tables.push(table)
    }
  }

  return tables
}

/**
 * Parse markdown table lines into ExtractedTable
 */
function parseMarkdownTableLines(
  lines: string[],
  startIndex: number,
  endIndex: number
): ExtractedTable | null {
  if (lines.length < 2) return null

  // First line is headers
  const headerLine = lines[0]
  const headers = parseTableRow(headerLine)

  if (headers.length === 0) return null

  // Second line should be separator (---)
  const separatorLine = lines[1]
  if (!/^\|[\s\-:|]+\|$/.test(separatorLine)) {
    // No separator, treat first row as data
    const rows = lines.map(parseTableRow)
    return {
      headers: rows[0] || [],
      rows: rows.slice(1),
      sourceType: "markdown",
      startIndex,
      endIndex,
    }
  }

  // Parse data rows (skip separator)
  const rows = lines.slice(2).map(parseTableRow)

  return {
    headers,
    rows,
    sourceType: "markdown",
    startIndex,
    endIndex,
  }
}

/**
 * Parse a single table row
 */
function parseTableRow(line: string): string[] {
  return line
    .split("|")
    .map((cell) => cell.trim())
    .filter((cell, index, arr) => {
      // Remove empty first and last cells (from leading/trailing |)
      if (index === 0 && cell === "") return false
      if (index === arr.length - 1 && cell === "") return false
      return true
    })
}

/**
 * Extract HTML tables from content
 */
export function extractHTMLTables(content: string): ExtractedTable[] {
  const tables: ExtractedTable[] = []

  // Simple regex-based extraction (for basic tables)
  const tableRegex = /<table[^>]*>([\s\S]*?)<\/table>/gi
  let match

  while ((match = tableRegex.exec(content)) !== null) {
    const tableHtml = match[0]
    const startIndex = match.index
    const endIndex = startIndex + tableHtml.length

    const table = parseHTMLTable(tableHtml, startIndex, endIndex)
    if (table) {
      tables.push(table)
    }
  }

  return tables
}

/**
 * Parse HTML table string into ExtractedTable
 */
function parseHTMLTable(html: string, startIndex: number, endIndex: number): ExtractedTable | null {
  const headers: string[] = []
  const rows: string[][] = []

  // Extract headers from <th> tags
  const thRegex = /<th[^>]*>([\s\S]*?)<\/th>/gi
  let thMatch
  while ((thMatch = thRegex.exec(html)) !== null) {
    headers.push(stripHtmlTags(thMatch[1]).trim())
  }

  // Extract rows from <tr> tags
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
  let trMatch
  let isFirstRow = true

  while ((trMatch = trRegex.exec(html)) !== null) {
    const rowHtml = trMatch[1]

    // Check if this row contains <th> (header row)
    if (/<th[^>]*>/i.test(rowHtml)) {
      // Already extracted headers above
      continue
    }

    // Extract cells from <td> tags
    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi
    const row: string[] = []
    let tdMatch

    while ((tdMatch = tdRegex.exec(rowHtml)) !== null) {
      row.push(stripHtmlTags(tdMatch[1]).trim())
    }

    if (row.length > 0) {
      // If no headers found and this is first data row, use as headers
      if (headers.length === 0 && isFirstRow) {
        headers.push(...row)
        isFirstRow = false
        continue
      }
      rows.push(row)
    }
    isFirstRow = false
  }

  if (headers.length === 0 && rows.length === 0) {
    return null
  }

  return {
    headers,
    rows,
    sourceType: "html",
    startIndex,
    endIndex,
  }
}

/**
 * Strip HTML tags from string
 */
function stripHtmlTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .trim()
}

/**
 * Detect if message content contains a table
 */
export function hasTable(content: string): boolean {
  // Check for markdown table
  const hasMarkdownTable = /^\|.+\|$/m.test(content) && /^\|[\s\-:|]+\|$/m.test(content)

  // Check for HTML table
  const hasHtmlTable = /<table[^>]*>/i.test(content)

  return hasMarkdownTable || hasHtmlTable
}

/**
 * Convert ExtractedTable to TableData format
 */
export function extractedTableToTableData(table: ExtractedTable): TableData {
  return {
    headers: table.headers,
    rows: table.rows,
    title: table.title,
  }
}

/**
 * Extract first table from content
 */
export function extractFirstTable(content: string): ExtractedTable | null {
  const result = extractTables(content)
  return result.tables[0] || null
}

/**
 * Convert plain text table to structured data
 * Handles space/tab separated values
 */
export function parseTextTable(content: string): ExtractedTable | null {
  const lines = content
    .trim()
    .split("\n")
    .filter((line) => line.trim())

  if (lines.length < 2) return null

  // Detect delimiter (tab or multiple spaces)
  const firstLine = lines[0]
  const delimiter = firstLine.includes("\t") ? "\t" : /\s{2,}/

  const allRows = lines.map((line) => {
    if (typeof delimiter === "string") {
      return line.split(delimiter).map((cell) => cell.trim())
    }
    return line.split(delimiter).map((cell) => cell.trim())
  })

  // Use first row as headers
  const headers = allRows[0]
  const rows = allRows.slice(1)

  return {
    headers,
    rows,
    sourceType: "text",
    startIndex: 0,
    endIndex: content.length,
  }
}

/**
 * Validate table structure
 */
export function validateTable(table: ExtractedTable): {
  valid: boolean
  errors: string[]
} {
  const errors: string[] = []

  if (table.headers.length === 0) {
    errors.push("Table has no headers")
  }

  if (table.rows.length === 0) {
    errors.push("Table has no data rows")
  }

  // Check for consistent column count
  const headerCount = table.headers.length
  const inconsistentRows = table.rows.filter((row) => row.length !== headerCount)

  if (inconsistentRows.length > 0) {
    errors.push(`${inconsistentRows.length} rows have inconsistent column count`)
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

/**
 * Normalize table (ensure all rows have same column count)
 */
export function normalizeTable(table: ExtractedTable): ExtractedTable {
  const maxColumns = Math.max(table.headers.length, ...table.rows.map((row) => row.length))

  // Pad headers if needed
  const headers = [...table.headers]
  while (headers.length < maxColumns) {
    headers.push(`Column ${headers.length + 1}`)
  }

  // Pad/trim rows to match column count
  const rows = table.rows.map((row) => {
    const newRow = [...row]
    while (newRow.length < maxColumns) {
      newRow.push("")
    }
    return newRow.slice(0, maxColumns)
  })

  return {
    ...table,
    headers,
    rows,
  }
}

/**
 * Merge multiple tables into one
 */
export function mergeTables(tables: ExtractedTable[]): ExtractedTable | null {
  if (tables.length === 0) return null
  if (tables.length === 1) return tables[0]

  // Use headers from first table
  const headers = tables[0].headers

  // Combine all rows
  const rows = tables.flatMap((table) => table.rows)

  return {
    headers,
    rows,
    sourceType: "markdown",
    startIndex: 0,
    endIndex: 0,
  }
}

/**
 * Convert table to markdown format
 */
export function tableToMarkdown(table: ExtractedTable): string {
  const lines: string[] = []

  // Header row
  lines.push("| " + table.headers.join(" | ") + " |")

  // Separator row
  lines.push("| " + table.headers.map(() => "---").join(" | ") + " |")

  // Data rows
  for (const row of table.rows) {
    // Pad row to match header length
    const paddedRow = [...row]
    while (paddedRow.length < table.headers.length) {
      paddedRow.push("")
    }
    lines.push("| " + paddedRow.slice(0, table.headers.length).join(" | ") + " |")
  }

  return lines.join("\n")
}

/**
 * Get table statistics
 */
export function getTableStats(table: ExtractedTable): {
  rowCount: number
  columnCount: number
  cellCount: number
  emptyCount: number
  numericColumnCount: number
} {
  const rowCount = table.rows.length
  const columnCount = table.headers.length
  const cellCount = rowCount * columnCount

  let emptyCount = 0
  const numericColumns = new Set<number>()

  for (let colIndex = 0; colIndex < columnCount; colIndex++) {
    let isNumeric = true

    for (const row of table.rows) {
      const cell = row[colIndex]

      if (!cell || cell.trim() === "") {
        emptyCount++
      }

      if (cell && isNaN(Number(cell))) {
        isNumeric = false
      }
    }

    if (isNumeric && table.rows.length > 0) {
      numericColumns.add(colIndex)
    }
  }

  return {
    rowCount,
    columnCount,
    cellCount,
    emptyCount,
    numericColumnCount: numericColumns.size,
  }
}
