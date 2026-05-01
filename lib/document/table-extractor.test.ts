/**
 * Tests for Table Extractor
 */

import {
  extractTables,
  extractMarkdownTables,
  extractHTMLTables,
  hasTable,
  extractedTableToTableData,
  extractFirstTable,
  parseTextTable,
  validateTable,
  normalizeTable,
  mergeTables,
  tableToMarkdown,
  getTableStats,
  type ExtractedTable,
} from "./table-extractor"

describe("extractTables", () => {
  it("should extract markdown tables", () => {
    const content = `
| Header1 | Header2 |
| ------- | ------- |
| Cell1   | Cell2   |
`
    const result = extractTables(content)
    expect(result.hasTable).toBe(true)
    expect(result.tableCount).toBe(1)
  })

  it("should extract HTML tables", () => {
    const content = "<table><tr><th>H1</th></tr><tr><td>D1</td></tr></table>"
    const result = extractTables(content)
    expect(result.hasTable).toBe(true)
  })

  it("should return empty for no tables", () => {
    const content = "Just plain text"
    const result = extractTables(content)
    expect(result.hasTable).toBe(false)
    expect(result.tableCount).toBe(0)
  })
})

describe("extractMarkdownTables", () => {
  it("should extract simple markdown table", () => {
    const content = `| A | B |
| - | - |
| 1 | 2 |`
    const tables = extractMarkdownTables(content)
    expect(tables).toHaveLength(1)
    expect(tables[0].headers).toEqual(["A", "B"])
    expect(tables[0].rows).toEqual([["1", "2"]])
  })

  it("should extract multiple tables", () => {
    const content = `| A | B |
| - | - |
| 1 | 2 |

Some text

| C | D |
| - | - |
| 3 | 4 |`
    const tables = extractMarkdownTables(content)
    expect(tables).toHaveLength(2)
  })

  it("should handle table at end of content", () => {
    const content = `Text before

| A | B |
| - | - |
| 1 | 2 |`
    const tables = extractMarkdownTables(content)
    expect(tables).toHaveLength(1)
  })

  it("should handle table without separator as data", () => {
    const content = `| A | B |
| 1 | 2 |
| 3 | 4 |`
    const tables = extractMarkdownTables(content)
    expect(tables).toHaveLength(1)
  })
})

describe("extractHTMLTables", () => {
  it("should extract HTML table with headers", () => {
    const content = `<table>
      <tr><th>Header1</th><th>Header2</th></tr>
      <tr><td>Data1</td><td>Data2</td></tr>
    </table>`
    const tables = extractHTMLTables(content)
    expect(tables).toHaveLength(1)
    expect(tables[0].headers).toEqual(["Header1", "Header2"])
    expect(tables[0].rows).toEqual([["Data1", "Data2"]])
  })

  it("should extract table without th elements", () => {
    const content = `<table>
      <tr><td>H1</td><td>H2</td></tr>
      <tr><td>D1</td><td>D2</td></tr>
    </table>`
    const tables = extractHTMLTables(content)
    expect(tables).toHaveLength(1)
    expect(tables[0].headers).toEqual(["H1", "H2"])
  })

  it("should strip HTML tags from cells", () => {
    const content = "<table><tr><td><b>Bold</b></td></tr></table>"
    const tables = extractHTMLTables(content)
    expect(tables[0].headers).toContain("Bold")
  })

  it("should return empty for no tables", () => {
    const tables = extractHTMLTables("No tables here")
    expect(tables).toHaveLength(0)
  })
})

describe("hasTable", () => {
  it("should detect markdown table", () => {
    const content = `| A | B |
| - | - |
| 1 | 2 |`
    expect(hasTable(content)).toBe(true)
  })

  it("should detect HTML table", () => {
    expect(hasTable("<table><tr></tr></table>")).toBe(true)
  })

  it("should return false for no table", () => {
    expect(hasTable("Just text")).toBe(false)
  })
})

describe("extractedTableToTableData", () => {
  it("should convert to TableData format", () => {
    const table: ExtractedTable = {
      headers: ["A", "B"],
      rows: [["1", "2"]],
      title: "Test",
      sourceType: "markdown",
      startIndex: 0,
      endIndex: 10,
    }
    const result = extractedTableToTableData(table)
    expect(result.headers).toEqual(["A", "B"])
    expect(result.rows).toEqual([["1", "2"]])
    expect(result.title).toBe("Test")
  })
})

describe("extractFirstTable", () => {
  it("should return first table", () => {
    const content = `| A | B |
| - | - |
| 1 | 2 |`
    const table = extractFirstTable(content)
    expect(table).not.toBeNull()
    expect(table?.headers).toEqual(["A", "B"])
  })

  it("should return null for no tables", () => {
    expect(extractFirstTable("No tables")).toBeNull()
  })
})

describe("parseTextTable", () => {
  it("should parse tab-separated values", () => {
    const content = `H1\tH2
D1\tD2`
    const table = parseTextTable(content)
    expect(table?.headers).toEqual(["H1", "H2"])
    expect(table?.rows).toEqual([["D1", "D2"]])
  })

  it("should parse space-separated values", () => {
    const content = `H1  H2
D1  D2`
    const table = parseTextTable(content)
    expect(table?.headers).toEqual(["H1", "H2"])
  })

  it("should return null for single line", () => {
    expect(parseTextTable("single line")).toBeNull()
  })
})

describe("validateTable", () => {
  it("should validate correct table", () => {
    const table: ExtractedTable = {
      headers: ["A", "B"],
      rows: [
        ["1", "2"],
        ["3", "4"],
      ],
      sourceType: "markdown",
      startIndex: 0,
      endIndex: 10,
    }
    const result = validateTable(table)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it("should detect no headers", () => {
    const table: ExtractedTable = {
      headers: [],
      rows: [["1", "2"]],
      sourceType: "markdown",
      startIndex: 0,
      endIndex: 10,
    }
    const result = validateTable(table)
    expect(result.valid).toBe(false)
    expect(result.errors).toContain("Table has no headers")
  })

  it("should detect no rows", () => {
    const table: ExtractedTable = {
      headers: ["A", "B"],
      rows: [],
      sourceType: "markdown",
      startIndex: 0,
      endIndex: 10,
    }
    const result = validateTable(table)
    expect(result.valid).toBe(false)
  })

  it("should detect inconsistent columns", () => {
    const table: ExtractedTable = {
      headers: ["A", "B"],
      rows: [["1"], ["2", "3", "4"]],
      sourceType: "markdown",
      startIndex: 0,
      endIndex: 10,
    }
    const result = validateTable(table)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes("inconsistent"))).toBe(true)
  })
})

describe("normalizeTable", () => {
  it("should pad short rows", () => {
    const table: ExtractedTable = {
      headers: ["A", "B", "C"],
      rows: [["1"], ["2", "3"]],
      sourceType: "markdown",
      startIndex: 0,
      endIndex: 10,
    }
    const result = normalizeTable(table)
    expect(result.rows[0]).toHaveLength(3)
    expect(result.rows[1]).toHaveLength(3)
  })

  it("should pad short headers", () => {
    const table: ExtractedTable = {
      headers: ["A"],
      rows: [["1", "2", "3"]],
      sourceType: "markdown",
      startIndex: 0,
      endIndex: 10,
    }
    const result = normalizeTable(table)
    expect(result.headers).toHaveLength(3)
  })

  it("should keep all row data when normalizing", () => {
    const table: ExtractedTable = {
      headers: ["A", "B"],
      rows: [["1", "2", "3", "4"]],
      sourceType: "markdown",
      startIndex: 0,
      endIndex: 10,
    }
    const result = normalizeTable(table)
    // normalizeTable expands headers to match max columns, doesn't trim rows
    expect(result.headers.length).toBeGreaterThanOrEqual(4)
  })
})

describe("mergeTables", () => {
  it("should merge multiple tables", () => {
    const table1: ExtractedTable = {
      headers: ["A", "B"],
      rows: [["1", "2"]],
      sourceType: "markdown",
      startIndex: 0,
      endIndex: 10,
    }
    const table2: ExtractedTable = {
      headers: ["A", "B"],
      rows: [["3", "4"]],
      sourceType: "markdown",
      startIndex: 0,
      endIndex: 10,
    }
    const result = mergeTables([table1, table2])
    expect(result?.rows).toHaveLength(2)
  })

  it("should return null for empty array", () => {
    expect(mergeTables([])).toBeNull()
  })

  it("should return single table unchanged", () => {
    const table: ExtractedTable = {
      headers: ["A"],
      rows: [["1"]],
      sourceType: "markdown",
      startIndex: 0,
      endIndex: 10,
    }
    expect(mergeTables([table])).toBe(table)
  })
})

describe("tableToMarkdown", () => {
  it("should convert to markdown format", () => {
    const table: ExtractedTable = {
      headers: ["A", "B"],
      rows: [["1", "2"]],
      sourceType: "html",
      startIndex: 0,
      endIndex: 10,
    }
    const md = tableToMarkdown(table)
    expect(md).toContain("| A | B |")
    expect(md).toContain("| --- | --- |")
    expect(md).toContain("| 1 | 2 |")
  })

  it("should pad short rows", () => {
    const table: ExtractedTable = {
      headers: ["A", "B", "C"],
      rows: [["1"]],
      sourceType: "markdown",
      startIndex: 0,
      endIndex: 10,
    }
    const md = tableToMarkdown(table)
    expect(md).toContain("| 1 |  |  |")
  })
})

describe("getTableStats", () => {
  it("should calculate correct stats", () => {
    const table: ExtractedTable = {
      headers: ["A", "B"],
      rows: [
        ["1", "2"],
        ["3", ""],
      ],
      sourceType: "markdown",
      startIndex: 0,
      endIndex: 10,
    }
    const stats = getTableStats(table)
    expect(stats.rowCount).toBe(2)
    expect(stats.columnCount).toBe(2)
    expect(stats.cellCount).toBe(4)
    expect(stats.emptyCount).toBe(1)
  })

  it("should detect numeric columns", () => {
    const table: ExtractedTable = {
      headers: ["Num", "Text"],
      rows: [
        ["1", "a"],
        ["2", "b"],
        ["3", "c"],
      ],
      sourceType: "markdown",
      startIndex: 0,
      endIndex: 10,
    }
    const stats = getTableStats(table)
    expect(stats.numericColumnCount).toBe(1)
  })
})
