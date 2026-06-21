/**
 * CSV Parser - Parse CSV and TSV files
 * Enhanced with type inference, column statistics, and multi-line quoted field support
 */

export interface CSVParseResult {
  text: string
  data: string[][]
  headers: string[]
  rowCount: number
  columnCount: number
  delimiter: string
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

export interface CSVParseOptions {
  delimiter?: string
  hasHeader?: boolean
  skipEmptyLines?: boolean
  trimValues?: boolean
  encoding?: string
}

const DEFAULT_OPTIONS: CSVParseOptions = {
  delimiter: undefined, // Auto-detect if not specified
  hasHeader: true,
  skipEmptyLines: true,
  trimValues: true,
}

/**
 * Detect delimiter from content
 */
export function detectDelimiter(content: string): string {
  const firstLine = content.split("\n")[0] || ""

  const delimiters = [",", "\t", ";", "|"]
  const counts = delimiters.map((d) => ({
    delimiter: d,
    count: (firstLine.match(new RegExp(escapeRegex(d), "g")) || []).length,
  }))

  // Sort by count descending
  counts.sort((a, b) => b.count - a.count)

  // Return the most common delimiter (if any found)
  return counts[0].count > 0 ? counts[0].delimiter : ","
}

/**
 * Escape special regex characters
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Parse CSV content
 */
export function parseCSV(content: string, options: CSVParseOptions = {}): CSVParseResult {
  const opts = { ...DEFAULT_OPTIONS, ...options }

  // Auto-detect delimiter if not specified
  const delimiter = opts.delimiter || detectDelimiter(content)

  // Use multi-line aware parser
  const data = parseLines(content, delimiter, opts.trimValues ?? true, opts.skipEmptyLines ?? true)

  // Extract headers
  const headers = opts.hasHeader && data.length > 0 ? data[0] : []
  const dataWithoutHeader = opts.hasHeader ? data.slice(1) : data

  // Calculate dimensions
  const columnCount = data.reduce((max, row) => Math.max(max, row.length), 0)

  // Generate text representation
  const text = generateText(headers, dataWithoutHeader, delimiter)

  return {
    text,
    data: opts.hasHeader ? dataWithoutHeader : data,
    headers,
    rowCount: dataWithoutHeader.length,
    columnCount,
    delimiter,
  }
}

/**
 * Parse CSV content handling multi-line quoted fields
 * Returns array of rows where each row is an array of cell values
 */
function parseLines(
  content: string,
  delimiter: string,
  trim: boolean,
  skipEmpty: boolean
): string[][] {
  const rows: string[][] = []
  let currentRow: string[] = []
  let current = ""
  let inQuotes = false
  let i = 0

  while (i < content.length) {
    const char = content[i]
    const nextChar = content[i + 1]

    if (inQuotes) {
      if (char === '"') {
        if (nextChar === '"') {
          // Escaped quote
          current += '"'
          i += 2
          continue
        } else {
          // End of quoted value
          inQuotes = false
          i++
          continue
        }
      } else {
        // Inside quotes, include everything (including newlines)
        current += char
        i++
        continue
      }
    }

    if (char === '"') {
      inQuotes = true
      i++
      continue
    }

    if (char === delimiter) {
      currentRow.push(trim ? current.trim() : current)
      current = ""
      i++
      continue
    }

    // Handle line breaks (not inside quotes)
    if (char === "\r" && nextChar === "\n") {
      currentRow.push(trim ? current.trim() : current)
      current = ""
      if (!skipEmpty || currentRow.some((c) => c !== "")) {
        rows.push(currentRow)
      }
      currentRow = []
      i += 2
      continue
    }

    if (char === "\n" || char === "\r") {
      currentRow.push(trim ? current.trim() : current)
      current = ""
      if (!skipEmpty || currentRow.some((c) => c !== "")) {
        rows.push(currentRow)
      }
      currentRow = []
      i++
      continue
    }

    current += char
    i++
  }

  // Flush remaining
  currentRow.push(trim ? current.trim() : current)
  if (!skipEmpty || currentRow.some((c) => c !== "")) {
    rows.push(currentRow)
  }

  return rows
}

/**
 * Generate text representation of CSV data
 */
function generateText(headers: string[], data: string[][], delimiter: string): string {
  const lines: string[] = []
  const delimiterName = delimiter === "\t" ? "TSV" : "CSV"

  lines.push(`[${delimiterName} Data]`)

  if (headers.length > 0) {
    lines.push(`Columns: ${headers.join(", ")}`)
    lines.push(`Rows: ${data.length}`)
    lines.push("")

    // Table format
    lines.push("| " + headers.join(" | ") + " |")
    lines.push("| " + headers.map(() => "---").join(" | ") + " |")

    for (const row of data.slice(0, 100)) {
      // Limit to first 100 rows for embedding
      const paddedRow = headers.map((_, i) => row[i] || "")
      lines.push("| " + paddedRow.join(" | ") + " |")
    }

    if (data.length > 100) {
      lines.push(`... and ${data.length - 100} more rows`)
    }
  } else {
    // No headers
    lines.push(`Rows: ${data.length}`)
    lines.push("")

    for (const row of data.slice(0, 100)) {
      lines.push(row.join(" | "))
    }

    if (data.length > 100) {
      lines.push(`... and ${data.length - 100} more rows`)
    }
  }

  return lines.join("\n")
}

/**
 * Parse CSV file
 */
export async function parseCSVFile(
  file: File,
  options: CSVParseOptions = {}
): Promise<CSVParseResult> {
  const content = await file.text()

  // Auto-detect TSV from extension
  const ext = file.name.split(".").pop()?.toLowerCase()
  if (ext === "tsv" && !options.delimiter) {
    options.delimiter = "\t"
  }

  return parseCSV(content, options)
}

/**
 * Convert CSV data to JSON objects
 */
export function csvToJSON(result: CSVParseResult): Record<string, string>[] {
  if (result.headers.length === 0) {
    return result.data.map((row, i) => {
      const obj: Record<string, string> = {}
      row.forEach((cell, j) => {
        obj[`col${j + 1}`] = cell
      })
      obj["_row"] = String(i + 1)
      return obj
    })
  }

  return result.data.map((row, i) => {
    const obj: Record<string, string> = {}
    result.headers.forEach((header, j) => {
      obj[header] = row[j] || ""
    })
    obj["_row"] = String(i + 1)
    return obj
  })
}

/**
 * Extract embeddable content from CSV with stats summary
 */
export function extractCSVEmbeddableContent(result: CSVParseResult): string {
  const parts: string[] = []

  // Add column type summary if headers present
  if (result.headers.length > 0) {
    const types = inferColumnTypes(result)
    const typeSummary = types.map((t) => `${t.columnName} (${t.inferredType})`).join(", ")
    parts.push(`Columns: ${typeSummary}`)
  }

  parts.push(result.text)

  return parts.join("\n\n")
}

/**
 * Generate statistics for CSV data
 */
export function getCSVStats(result: CSVParseResult): {
  rowCount: number
  columnCount: number
  emptyCount: number
  numericColumns: string[]
} {
  const stats = {
    rowCount: result.rowCount,
    columnCount: result.columnCount,
    emptyCount: 0,
    numericColumns: [] as string[],
  }

  // Count empty cells
  for (const row of result.data) {
    for (const cell of row) {
      if (cell === "" || cell === null || cell === undefined) {
        stats.emptyCount++
      }
    }
  }

  // Detect numeric columns
  if (result.headers.length > 0) {
    result.headers.forEach((header, colIndex) => {
      const values = result.data.map((row) => row[colIndex]).filter((v) => v !== "")
      const numericCount = values.filter((v) => !isNaN(Number(v))).length

      if (numericCount > values.length * 0.8) {
        stats.numericColumns.push(header)
      }
    })
  }

  return stats
}

/**
 * Infer column types from CSV data
 */
export function inferColumnTypes(result: CSVParseResult): ColumnTypeInfo[] {
  const columnCount = result.headers.length || result.columnCount
  const types: ColumnTypeInfo[] = []

  for (let col = 0; col < columnCount; col++) {
    const colName = result.headers[col] || `col${col + 1}`
    const values = result.data.map((row) => row[col] ?? "").filter((v) => v !== "")
    const nullCount = result.data.length - values.length
    const uniqueValues = new Set(values)

    if (values.length === 0) {
      types.push({
        columnIndex: col,
        columnName: colName,
        inferredType: "empty",
        sampleValues: [],
        nullCount,
        uniqueCount: 0,
      })
      continue
    }

    // Count type matches
    let numericCount = 0
    let booleanCount = 0
    let dateCount = 0

    for (const v of values) {
      if (!isNaN(Number(v)) && v.trim() !== "") numericCount++
      if (["true", "false", "yes", "no", "0", "1"].includes(v.toLowerCase())) booleanCount++
      if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(v) && !isNaN(Date.parse(v))) dateCount++
    }

    const threshold = values.length * 0.8
    let inferredType: ColumnType

    if (numericCount >= threshold) {
      inferredType = "number"
    } else if (dateCount >= threshold) {
      inferredType = "date"
    } else if (booleanCount >= threshold) {
      inferredType = "boolean"
    } else if (numericCount > 0 || dateCount > 0 || booleanCount > 0) {
      inferredType = "mixed"
    } else {
      inferredType = "string"
    }

    types.push({
      columnIndex: col,
      columnName: colName,
      inferredType,
      sampleValues: values.slice(0, 5),
      nullCount,
      uniqueCount: uniqueValues.size,
    })
  }

  return types
}

/**
 * Get detailed column statistics including min/max/mean/median for numeric columns
 */
export function getColumnStats(result: CSVParseResult): ColumnStats[] {
  const typeInfos = inferColumnTypes(result)
  const stats: ColumnStats[] = []

  for (const typeInfo of typeInfos) {
    const values = result.data.map((row) => row[typeInfo.columnIndex] ?? "")
    const nonEmpty = values.filter((v) => v !== "")

    const stat: ColumnStats = {
      columnIndex: typeInfo.columnIndex,
      columnName: typeInfo.columnName,
      type: typeInfo.inferredType,
      count: nonEmpty.length,
      nullCount: typeInfo.nullCount,
      uniqueCount: typeInfo.uniqueCount,
    }

    // Compute numeric stats for number columns
    if (typeInfo.inferredType === "number") {
      const nums = nonEmpty.map((v) => Number(v)).filter((n) => !isNaN(n))

      if (nums.length > 0) {
        nums.sort((a, b) => a - b)
        stat.min = nums[0]
        stat.max = nums[nums.length - 1]
        stat.mean = nums.reduce((sum, n) => sum + n, 0) / nums.length

        // Median
        const mid = Math.floor(nums.length / 2)
        stat.median = nums.length % 2 === 0 ? (nums[mid - 1] + nums[mid]) / 2 : nums[mid]
      }
    }

    stats.push(stat)
  }

  return stats
}
