/**
 * Tests for Office Parser (Word and Excel)
 *
 * NOTE: Office parsing requires actual binary data which is difficult to mock.
 * These tests focus on utility functions and type checking.
 * For full parsing tests, use e2e tests with real Office files.
 */

import {
  extractWordEmbeddableContent,
  extractExcelEmbeddableContent,
  detectOfficeType,
  type WordParseResult,
  type ExcelParseResult,
  type ExcelSheet,
} from "./office-parser"

describe("Office Parser", () => {
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

// Note: parseWord, parseWordFile, parseExcel, and parseExcelFile functions
// require actual Office binary data and external libraries (mammoth, xlsx)
// which may have ESM compatibility issues with Jest.
// These should be tested via e2e tests or integration tests.
describe.skip("Office parsing functions (requires real Office files)", () => {
  it.todo("parseWord - parses Word ArrayBuffer")
  it.todo("parseWordFile - parses Word File object")
  it.todo("parseExcel - parses Excel ArrayBuffer")
  it.todo("parseExcelFile - parses Excel File object")
})
