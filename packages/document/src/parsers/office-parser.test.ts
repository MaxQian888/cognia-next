/**
 * Tests for Office Parser (Word and Excel)
 *
 * NOTE: Office parsing requires actual binary data which is difficult to mock.
 * These tests focus on utility functions and type checking.
 * For full parsing tests, use e2e tests with real Office files.
 */

import {
  parseWord,
  parseWordFile,
  parseExcel,
  parseExcelFile,
  extractWordEmbeddableContent,
  extractExcelEmbeddableContent,
  detectOfficeType,
  type WordParseResult,
  type ExcelParseResult,
  type ExcelSheet,
} from "./office-parser"

jest.mock("mammoth", () => ({
  __esModule: true,
  default: {
    images: {
      imgElement: jest.fn(
        (
          handler: (image: {
            read: (encoding: string) => Promise<string>
            contentType: string
          }) => Promise<{ src: string }>
        ) => handler
      ),
    },
    convertToHtml: jest.fn(),
    extractRawText: jest.fn(),
  },
}))

jest.mock("xlsx", () => ({
  __esModule: true,
  read: jest.fn(),
  utils: {
    sheet_to_json: jest.fn(),
    encode_col: jest.fn((index: number) => String.fromCharCode(65 + index)),
  },
}))

const mammothMock = jest.requireMock("mammoth").default as {
  images: { imgElement: jest.Mock }
  convertToHtml: jest.Mock
  extractRawText: jest.Mock
}

const xlsxMock = jest.requireMock("xlsx") as {
  read: jest.Mock
  utils: {
    sheet_to_json: jest.Mock
    encode_col: jest.Mock
  }
}

function utf8ArrayBuffer(text: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(text)
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength)
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe("Office Parser", () => {
  describe("parseWord", () => {
    it("extracts raw text, html headings, messages, images, style options, and docx metadata", async () => {
      const metadataXml = `
        <cp:coreProperties>
          <dc:title>Quarterly Plan</dc:title>
          <dc:creator>Ada</dc:creator>
          <cp:lastModifiedBy>Grace</cp:lastModifiedBy>
          <dc:description>Planning document</dc:description>
          <dc:subject>Roadmap</dc:subject>
          <cp:keywords>planning,roadmap</cp:keywords>
          <dcterms:created>2024-01-02T03:04:05.000Z</dcterms:created>
          <dcterms:modified>not-a-date</dcterms:modified>
          <cp:revision>7</cp:revision>
        </cp:coreProperties>
      `

      mammothMock.convertToHtml.mockImplementation(async (_input, options) => {
        await options.convertImage({
          contentType: "image/png",
          read: jest.fn().mockResolvedValue("image-base64"),
        })

        expect(options.styleMap).toEqual(["p[style-name='Title'] => h1:fresh"])

        return {
          value: "<h1>Main <em>Title</em></h1><h2>Details</h2><p>Body</p>",
          messages: [{ type: "warning", message: "Converted with warning" }],
        }
      })
      mammothMock.extractRawText.mockResolvedValue({ value: "Plain document text" })

      const result = await parseWord(utf8ArrayBuffer(metadataXml), {
        extractImages: true,
        styleMap: ["p[style-name='Title'] => h1:fresh"],
      })

      expect(result).toMatchObject({
        text: "Plain document text",
        html: "<h1>Main <em>Title</em></h1><h2>Details</h2><p>Body</p>",
        messages: [{ type: "warning", message: "Converted with warning" }],
        images: [{ contentType: "image/png", base64: "image-base64" }],
        headings: [
          { level: 1, text: "Main Title" },
          { level: 2, text: "Details" },
        ],
        metadata: {
          title: "Quarterly Plan",
          author: "Ada",
          lastModifiedBy: "Grace",
          description: "Planning document",
          subject: "Roadmap",
          keywords: "planning,roadmap",
          revision: 7,
          modified: undefined,
        },
      })
      expect(result.metadata?.created?.toISOString()).toBe("2024-01-02T03:04:05.000Z")
      expect(mammothMock.images.imgElement).toHaveBeenCalledTimes(1)
    })

    it("honors disabled image and metadata extraction and reads File objects", async () => {
      mammothMock.convertToHtml.mockResolvedValue({
        value: "<p>No headings</p>",
        messages: [],
      })
      mammothMock.extractRawText.mockResolvedValue({ value: "No metadata" })

      const result = await parseWord(utf8ArrayBuffer("plain docx bytes"), {
        extractImages: false,
        extractMetadata: false,
      })

      expect(result.images).toEqual([])
      expect(result.metadata).toBeUndefined()
      expect(result.headings).toEqual([])
      expect(mammothMock.images.imgElement).not.toHaveBeenCalled()

      const file = {
        arrayBuffer: jest.fn().mockResolvedValue(utf8ArrayBuffer("file bytes")),
      } as unknown as File

      await expect(parseWordFile(file, { extractMetadata: false })).resolves.toMatchObject({
        text: "No metadata",
      })
      expect(file.arrayBuffer).toHaveBeenCalledTimes(1)
    })
  })

  describe("parseExcel", () => {
    it("extracts selected sheets with merges, limits rows, stats, and formatted text", async () => {
      const dataRows = [
        ["Name", "Score", "Active", "Started", "Ratio"],
        ["Ada", 42, true, new Date("2024-02-03T00:00:00.000Z"), 12.345],
        ["Grace", null, false, "2024-03-04", 7],
      ] as unknown as (string | number | boolean | null)[][]
      const emptyRows: (string | number | boolean | null)[][] = []
      const workbook = {
        SheetNames: ["Data", "Empty", "Skipped"],
        Sheets: {
          Data: {
            __rows: dataRows,
            "!merges": [{ s: { c: 0, r: 0 }, e: { c: 1, r: 0 } }],
          },
          Empty: { __rows: emptyRows },
          Skipped: { __rows: [["Should not parse"]] },
        },
      }

      xlsxMock.read.mockReturnValue(workbook)
      xlsxMock.utils.sheet_to_json.mockImplementation(
        (worksheet: { __rows: (string | number | boolean | null)[][] }) => worksheet.__rows
      )

      const result = await parseExcel(utf8ArrayBuffer("xlsx bytes"), {
        cellDates: true,
        cellFormula: true,
        sheetFilter: ["Data", "Empty"],
        maxRows: 2,
      })

      expect(xlsxMock.read.mock.calls[0][0]).toHaveProperty("byteLength")
      expect(xlsxMock.read.mock.calls[0][1]).toEqual({
        type: "array",
        cellDates: true,
        cellFormula: true,
      })
      expect(result.sheetNames).toEqual(["Data", "Empty", "Skipped"])
      expect(result.sheets).toEqual([
        {
          name: "Data",
          data: dataRows.slice(0, 2),
          rowCount: 2,
          columnCount: 5,
          mergedCells: ["A1:B1"],
        },
        {
          name: "Empty",
          data: [],
          rowCount: 0,
          columnCount: 0,
          mergedCells: undefined,
        },
      ])
      expect(result.sheetStats).toEqual([
        {
          name: "Data",
          rowCount: 2,
          columnCount: 5,
          mergedCellCount: 1,
          emptyRate: 0,
          columnTypes: {
            0: "string",
            1: "mixed",
            2: "mixed",
            3: "mixed",
            4: "mixed",
          },
        },
        {
          name: "Empty",
          rowCount: 0,
          columnCount: 0,
          mergedCellCount: 0,
          emptyRate: 0,
          columnTypes: {},
        },
      ])
      expect(result.text).toContain("Merged cells: A1:B1")
      expect(result.text).toContain("Name | Score | Active | Started | Ratio")
      expect(result.text).toContain("Ada | 42 | TRUE |")
      expect(result.text).toContain("12.35")
      expect(result.text).toContain("(empty sheet)")
    })

    it("parses all sheets without row limits and reads File objects", async () => {
      const workbook = {
        SheetNames: ["Values"],
        Sheets: {
          Values: {
            __rows: [
              [1.234, false, null],
              ["2024-05-06", 3, true],
            ],
          },
        },
      }

      xlsxMock.read.mockReturnValue(workbook)
      xlsxMock.utils.sheet_to_json.mockImplementation(
        (worksheet: { __rows: (string | number | boolean | null)[][] }) => worksheet.__rows
      )

      const parsed = await parseExcel(utf8ArrayBuffer("xlsx bytes"))

      expect(xlsxMock.read.mock.calls[0][0]).toHaveProperty("byteLength")
      expect(xlsxMock.read.mock.calls[0][1]).toEqual({ type: "array" })
      expect(parsed.sheets[0]).toMatchObject({
        name: "Values",
        rowCount: 2,
        columnCount: 3,
      })
      expect(parsed.text).toContain("1.23 | FALSE |")
      expect(parsed.sheetStats?.[0].columnTypes).toEqual({
        0: "mixed",
        1: "mixed",
        2: "boolean",
      })

      const file = {
        arrayBuffer: jest.fn().mockResolvedValue(utf8ArrayBuffer("file xlsx bytes")),
      } as unknown as File

      await expect(parseExcelFile(file)).resolves.toMatchObject({
        sheetNames: ["Values"],
      })
      expect(file.arrayBuffer).toHaveBeenCalledTimes(1)
    })
  })

  describe("detectOfficeType", () => {
    it("detects Word documents", () => {
      expect(detectOfficeType("document.docx")).toBe("word")
      expect(detectOfficeType("document.doc")).toBe("word")
      expect(detectOfficeType("template.docm")).toBe("word")
      expect(detectOfficeType("notes.odt")).toBe("word")
      expect(detectOfficeType("DOCUMENT.DOCX")).toBe("word")
    })

    it("detects Excel files", () => {
      expect(detectOfficeType("spreadsheet.xlsx")).toBe("excel")
      expect(detectOfficeType("spreadsheet.xls")).toBe("excel")
      expect(detectOfficeType("financials.xlsm")).toBe("excel")
      expect(detectOfficeType("budget.ods")).toBe("excel")
      expect(detectOfficeType("SPREADSHEET.XLSX")).toBe("excel")
    })

    it("returns unknown for non-Office files", () => {
      expect(detectOfficeType("file.txt")).toBe("unknown")
      expect(detectOfficeType("file.pdf")).toBe("unknown")
      expect(detectOfficeType("file.md")).toBe("unknown")
      expect(detectOfficeType("file")).toBe("unknown")
    })

    it("handles files with multiple dots", () => {
      expect(detectOfficeType("my.document.v2.docx")).toBe("word")
      expect(detectOfficeType("data.backup.xlsx")).toBe("excel")
    })
  })

  describe("extractWordEmbeddableContent", () => {
    it("returns text content", () => {
      const result: WordParseResult = {
        text: "This is the document content.",
        html: "<p>This is the document content.</p>",
        messages: [],
        images: [],
      }

      const embeddable = extractWordEmbeddableContent(result)
      expect(embeddable).toBe("This is the document content.")
    })

    it("handles empty content", () => {
      const result: WordParseResult = {
        text: "",
        html: "",
        messages: [],
        images: [],
      }

      const embeddable = extractWordEmbeddableContent(result)
      expect(embeddable).toBe("")
    })

    it("handles content with warnings", () => {
      const result: WordParseResult = {
        text: "Content with issues.",
        html: "<p>Content with issues.</p>",
        messages: [{ type: "warning", message: "Some formatting was lost" }],
        images: [],
      }

      const embeddable = extractWordEmbeddableContent(result)
      expect(embeddable).toBe("Content with issues.")
    })

    it("includes title, author, and heading structure when available", () => {
      const result: WordParseResult = {
        text: "Body content",
        html: "<h1>Plan</h1>",
        messages: [],
        images: [],
        metadata: {
          title: "Launch Plan",
          author: "Ada",
        },
        headings: [
          { level: 1, text: "Overview" },
          { level: 3, text: "Risks" },
        ],
      }

      expect(extractWordEmbeddableContent(result)).toBe(
        "Title: Launch Plan\n\nAuthor: Ada\n\nDocument Structure:\n\n# Overview\n    ### Risks\n\nBody content"
      )
    })
  })

  describe("extractExcelEmbeddableContent", () => {
    it("returns formatted text", () => {
      const result: ExcelParseResult = {
        text: "## Sheet: Sheet1\nname | age\n--- | ---\nJohn | 30",
        sheets: [
          {
            name: "Sheet1",
            data: [["John", "30"]],
            rowCount: 1,
            columnCount: 2,
          },
        ],
        sheetNames: ["Sheet1"],
      }

      const embeddable = extractExcelEmbeddableContent(result)
      expect(embeddable).toContain("Sheet1")
      expect(embeddable).toContain("John")
    })

    it("handles empty spreadsheet", () => {
      const result: ExcelParseResult = {
        text: "",
        sheets: [],
        sheetNames: [],
      }

      const embeddable = extractExcelEmbeddableContent(result)
      expect(embeddable).toBe("")
    })

    it("includes sheet statistics summary with merged-cell counts", () => {
      const result: ExcelParseResult = {
        text: "## Sheet: Data",
        sheets: [],
        sheetNames: ["Data", "Empty"],
        sheetStats: [
          {
            name: "Data",
            rowCount: 3,
            columnCount: 4,
            mergedCellCount: 2,
            emptyRate: 0.1,
            columnTypes: {},
          },
          {
            name: "Empty",
            rowCount: 0,
            columnCount: 0,
            mergedCellCount: 0,
            emptyRate: 0,
            columnTypes: {},
          },
        ],
      }

      expect(extractExcelEmbeddableContent(result)).toBe(
        "Sheets: Data: 3 rows × 4 cols, 2 merged; Empty: 0 rows × 0 cols\n\n## Sheet: Data"
      )
    })
  })

  describe("WordParseResult type", () => {
    it("supports all fields", () => {
      const result: WordParseResult = {
        text: "Plain text content",
        html: "<p>HTML content</p>",
        messages: [
          { type: "warning", message: "Warning message" },
          { type: "error", message: "Error message" },
        ],
        images: [{ contentType: "image/png", base64: "base64data" }],
      }

      expect(result.text).toBe("Plain text content")
      expect(result.html).toContain("HTML content")
      expect(result.messages).toHaveLength(2)
      expect(result.messages[0].type).toBe("warning")
      expect(result.images).toHaveLength(1)
    })
  })

  describe("ExcelParseResult type", () => {
    it("supports multiple sheets", () => {
      const sheet1: ExcelSheet = {
        name: "Data",
        data: [
          ["Name", "Age", "City"],
          ["John", "30", "NYC"],
          ["Jane", "25", "LA"],
        ],
        rowCount: 2,
        columnCount: 3,
      }

      const sheet2: ExcelSheet = {
        name: "Summary",
        data: [["Total", "2"]],
        rowCount: 1,
        columnCount: 2,
      }

      const result: ExcelParseResult = {
        text: "Combined text",
        sheets: [sheet1, sheet2],
        sheetNames: ["Data", "Summary"],
      }

      expect(result.sheets).toHaveLength(2)
      expect(result.sheetNames).toEqual(["Data", "Summary"])
      expect(result.sheets[0].data[0]).toEqual(["Name", "Age", "City"])
    })

    it("supports various cell types", () => {
      const sheet: ExcelSheet = {
        name: "Mixed",
        data: [
          ["Text", 123, true, null],
          ["Another", 45.67, false, null],
        ],
        rowCount: 2,
        columnCount: 4,
      }

      expect(sheet.data[0][0]).toBe("Text")
      expect(sheet.data[0][1]).toBe(123)
      expect(sheet.data[0][2]).toBe(true)
      expect(sheet.data[0][3]).toBeNull()
      expect(sheet.data[1][1]).toBe(45.67)
    })
  })

  describe("ExcelSheet type", () => {
    it("tracks dimensions correctly", () => {
      const sheet: ExcelSheet = {
        name: "Test",
        data: [
          ["A", "B", "C", "D", "E"],
          ["1", "2", "3", "4", "5"],
          ["6", "7", "8", "9", "10"],
        ],
        rowCount: 3,
        columnCount: 5,
      }

      expect(sheet.rowCount).toBe(3)
      expect(sheet.columnCount).toBe(5)
      expect(sheet.data.length).toBe(sheet.rowCount)
      expect(sheet.data[0].length).toBe(sheet.columnCount)
    })

    it("handles empty sheet", () => {
      const sheet: ExcelSheet = {
        name: "Empty",
        data: [],
        rowCount: 0,
        columnCount: 0,
      }

      expect(sheet.data).toHaveLength(0)
      expect(sheet.rowCount).toBe(0)
    })
  })
})
