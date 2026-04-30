/**
 * Canvas Utils - Unit Tests
 */

import {
  formatRelativeDate,
  getDateKey,
  formatFileSize,
  FILE_EXTENSION_MAP,
  MONACO_LANGUAGE_MAP,
  getMonacoLanguage,
  getFileExtension,
  generateSafeFilename,
  calculateDocumentStats,
  getCanvasPerformanceProfile,
  isLargeDocument,
  truncateText,
  isDesignerCompatible,
  exportCanvasDocument,
  getConnectionStatusColor,
  CANVAS_LARGE_DOCUMENT_THRESHOLDS,
} from "./utils"

describe("Canvas Utils", () => {
  describe("formatRelativeDate", () => {
    const mockT = jest.fn((key: string, params?: Record<string, unknown>) => {
      if (key === "justNow") return "just now"
      if (key === "minutesAgo") return `${params?.count} minutes ago`
      if (key === "hoursAgo") return `${params?.count} hours ago`
      if (key === "daysAgo") return `${params?.count} days ago`
      return key
    })

    beforeEach(() => {
      mockT.mockClear()
    })

    it('should return "just now" for dates less than 1 minute ago', () => {
      const date = new Date()
      const result = formatRelativeDate(date, mockT)
      expect(result).toBe("just now")
    })

    it("should return minutes ago for dates less than 1 hour ago", () => {
      const date = new Date(Date.now() - 30 * 60 * 1000) // 30 minutes ago
      const result = formatRelativeDate(date, mockT)
      expect(result).toBe("30 minutes ago")
    })

    it("should return hours ago for dates less than 24 hours ago", () => {
      const date = new Date(Date.now() - 5 * 60 * 60 * 1000) // 5 hours ago
      const result = formatRelativeDate(date, mockT)
      expect(result).toBe("5 hours ago")
    })

    it("should return days ago for dates less than 7 days ago", () => {
      const date = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) // 3 days ago
      const result = formatRelativeDate(date, mockT)
      expect(result).toBe("3 days ago")
    })

    it("should return formatted date for dates more than 7 days ago", () => {
      const date = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) // 10 days ago
      const result = formatRelativeDate(date, mockT)
      expect(typeof result).toBe("string")
      expect(result).not.toBe("just now")
    })
  })

  describe("getDateKey", () => {
    it("should return consistent date key for same date", () => {
      const date = new Date("2024-01-15")
      const key1 = getDateKey(date)
      const key2 = getDateKey(date)
      expect(key1).toBe(key2)
    })

    it("should return different keys for different dates", () => {
      const date1 = new Date("2024-01-15")
      const date2 = new Date("2024-01-16")
      expect(getDateKey(date1)).not.toBe(getDateKey(date2))
    })
  })

  describe("formatFileSize", () => {
    it('should return "0 B" for 0 bytes', () => {
      expect(formatFileSize(0)).toBe("0 B")
    })

    it("should format bytes correctly", () => {
      expect(formatFileSize(500)).toBe("500 B")
    })

    it("should format kilobytes correctly", () => {
      expect(formatFileSize(1024)).toBe("1 KB")
      expect(formatFileSize(1536)).toBe("1.5 KB")
    })

    it("should format megabytes correctly", () => {
      expect(formatFileSize(1024 * 1024)).toBe("1 MB")
      expect(formatFileSize(2.5 * 1024 * 1024)).toBe("2.5 MB")
    })

    it("should format gigabytes correctly", () => {
      expect(formatFileSize(1024 * 1024 * 1024)).toBe("1 GB")
    })
  })

  describe("FILE_EXTENSION_MAP", () => {
    it("should have correct mappings", () => {
      expect(FILE_EXTENSION_MAP.javascript).toBe("js")
      expect(FILE_EXTENSION_MAP.typescript).toBe("ts")
      expect(FILE_EXTENSION_MAP.python).toBe("py")
      expect(FILE_EXTENSION_MAP.markdown).toBe("md")
    })
  })

  describe("MONACO_LANGUAGE_MAP", () => {
    it("should have correct mappings", () => {
      expect(MONACO_LANGUAGE_MAP.javascript).toBe("javascript")
      expect(MONACO_LANGUAGE_MAP.typescript).toBe("typescript")
      expect(MONACO_LANGUAGE_MAP.jsx).toBe("javascript")
      expect(MONACO_LANGUAGE_MAP.tsx).toBe("typescript")
    })
  })

  describe("getMonacoLanguage", () => {
    it("should return correct Monaco language for known languages", () => {
      expect(getMonacoLanguage("javascript")).toBe("javascript")
      expect(getMonacoLanguage("typescript")).toBe("typescript")
      expect(getMonacoLanguage("python")).toBe("python")
    })

    it("should return plaintext for unknown languages", () => {
      expect(getMonacoLanguage("unknown")).toBe("plaintext")
      expect(getMonacoLanguage("")).toBe("plaintext")
    })
  })

  describe("getFileExtension", () => {
    it("should return correct extension for known languages", () => {
      expect(getFileExtension("javascript")).toBe("js")
      expect(getFileExtension("typescript")).toBe("ts")
      expect(getFileExtension("python")).toBe("py")
    })

    it("should return txt for unknown languages", () => {
      expect(getFileExtension("unknown")).toBe("txt")
    })
  })

  describe("generateSafeFilename", () => {
    it("should generate safe filename with correct extension", () => {
      expect(generateSafeFilename("My File", "javascript")).toBe("My_File.js")
      expect(generateSafeFilename("test.py", "python")).toBe("test_py.py")
    })

    it("should replace special characters with underscores", () => {
      expect(generateSafeFilename("Hello World!", "typescript")).toBe("Hello_World_.ts")
      expect(generateSafeFilename("test@file#1", "javascript")).toBe("test_file_1.js")
    })
  })

  describe("calculateDocumentStats", () => {
    it("should return zeros for empty content", () => {
      const stats = calculateDocumentStats("")
      expect(stats.lines).toBe(0)
      expect(stats.words).toBe(0)
      expect(stats.chars).toBe(0)
    })

    it("should calculate correct stats for single line", () => {
      const stats = calculateDocumentStats("Hello World")
      expect(stats.lines).toBe(1)
      expect(stats.words).toBe(2)
      expect(stats.chars).toBe(11)
    })

    it("should calculate correct stats for multi-line content", () => {
      const content = "Line 1\nLine 2\nLine 3"
      const stats = calculateDocumentStats(content)
      expect(stats.lines).toBe(3)
      expect(stats.words).toBe(6)
      expect(stats.chars).toBe(20)
    })

    it("should handle content with only whitespace", () => {
      const stats = calculateDocumentStats("   \n   \n   ")
      expect(stats.lines).toBe(3)
      expect(stats.words).toBe(0)
    })
  })

  describe("isLargeDocument", () => {
    it("should return false for small documents", () => {
      expect(isLargeDocument("Hello")).toBe(false)
      expect(isLargeDocument("a".repeat(1000))).toBe(false)
    })

    it("should return true for documents over default threshold (50000)", () => {
      expect(isLargeDocument("a".repeat(50001))).toBe(true)
    })

    it("should respect custom threshold", () => {
      expect(isLargeDocument("a".repeat(1001), 1000)).toBe(true)
      expect(isLargeDocument("a".repeat(999), 1000)).toBe(false)
    })
  })

  describe("getCanvasPerformanceProfile", () => {
    it("should keep small documents in standard mode", () => {
      const profile = getCanvasPerformanceProfile("const small = true;")

      expect(profile.mode).toBe("standard")
      expect(profile.enableChunking).toBe(false)
      expect(profile.outlineRefresh).toBe("eager")
      expect(profile.symbolParseDebounceMs).toBe(500)
    })

    it("should switch to large mode when content crosses the large threshold", () => {
      const profile = getCanvasPerformanceProfile(
        "a".repeat(CANVAS_LARGE_DOCUMENT_THRESHOLDS.largeChars + 1)
      )

      expect(profile.mode).toBe("large")
      expect(profile.enableChunking).toBe(true)
      expect(profile.outlineRefresh).toBe("deferred")
      expect(profile.showDegradedModeNotice).toBe(true)
    })

    it("should switch to very-large mode when content crosses the very-large threshold", () => {
      const profile = getCanvasPerformanceProfile(
        "line\n".repeat(CANVAS_LARGE_DOCUMENT_THRESHOLDS.veryLargeLines + 1)
      )

      expect(profile.mode).toBe("very-large")
      expect(profile.outlineRefresh).toBe("manual")
      expect(profile.showStickyScroll).toBe(false)
      expect(profile.symbolParseDebounceMs).toBe(1500)
    })
  })

  describe("truncateText", () => {
    it("should not truncate text shorter than maxLength", () => {
      expect(truncateText("Hello", 10)).toBe("Hello")
    })

    it("should truncate text longer than maxLength with ellipsis", () => {
      expect(truncateText("Hello World", 8)).toBe("Hello...")
    })

    it("should handle exact length", () => {
      expect(truncateText("Hello", 5)).toBe("Hello")
    })

    it("should handle very short maxLength", () => {
      expect(truncateText("Hello World", 4)).toBe("H...")
    })
  })

  describe("isDesignerCompatible", () => {
    it("should return true for supported languages", () => {
      expect(isDesignerCompatible("jsx")).toBe(true)
      expect(isDesignerCompatible("tsx")).toBe(true)
      expect(isDesignerCompatible("html")).toBe(true)
      expect(isDesignerCompatible("javascript")).toBe(true)
      expect(isDesignerCompatible("typescript")).toBe(true)
    })

    it("should return false for unsupported languages", () => {
      expect(isDesignerCompatible("python")).toBe(false)
      expect(isDesignerCompatible("css")).toBe(false)
      expect(isDesignerCompatible("json")).toBe(false)
      expect(isDesignerCompatible("markdown")).toBe(false)
      expect(isDesignerCompatible("")).toBe(false)
    })
  })

  describe("exportCanvasDocument", () => {
    it("should create a download link and trigger click", () => {
      const createObjectURL = jest.fn(() => "blob:test")
      const revokeObjectURL = jest.fn()
      const clickSpy = jest.fn()
      const appendChildSpy = jest
        .spyOn(document.body, "appendChild")
        .mockImplementation((node) => node)
      const removeChildSpy = jest
        .spyOn(document.body, "removeChild")
        .mockImplementation((node) => node)

      Object.defineProperty(global, "URL", {
        value: { createObjectURL, revokeObjectURL },
        writable: true,
      })

      const mockAnchor = {
        href: "",
        download: "",
        click: clickSpy,
      } as unknown as HTMLAnchorElement
      jest.spyOn(document, "createElement").mockReturnValueOnce(mockAnchor)

      exportCanvasDocument("My Document", 'console.log("hi")', "javascript")

      expect(mockAnchor.download).toBe("My_Document.js")
      expect(clickSpy).toHaveBeenCalled()
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:test")

      appendChildSpy.mockRestore()
      removeChildSpy.mockRestore()
    })
  })

  describe("getConnectionStatusColor", () => {
    it("should return green for connected", () => {
      expect(getConnectionStatusColor("connected")).toBe("text-green-500")
    })

    it("should return yellow for connecting", () => {
      expect(getConnectionStatusColor("connecting")).toBe("text-yellow-500")
    })

    it("should return red for error", () => {
      expect(getConnectionStatusColor("error")).toBe("text-red-500")
    })

    it("should return muted-foreground for disconnected/reconnecting state", () => {
      expect(getConnectionStatusColor("disconnected")).toBe("text-muted-foreground")
      expect(getConnectionStatusColor("reconnecting")).toBe("text-muted-foreground")
    })
  })
})
