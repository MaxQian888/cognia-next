import {
  mapWordMessages,
  createBlockingDiagnostic,
  attachDiagnosticToError,
} from "./parse-diagnostics"

describe("parse-diagnostics", () => {
  describe("mapWordMessages", () => {
    it("maps warning messages to parser_warning diagnostics", () => {
      const result = mapWordMessages([{ type: "warning", message: "Some comments were skipped" }])

      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        code: "parser_warning",
        severity: "warning",
        message: "Some comments were skipped",
      })
    })

    it("maps error messages to parse_failed diagnostics", () => {
      const result = mapWordMessages([{ type: "error", message: "Cannot read content" }])

      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        code: "parse_failed",
        severity: "error",
        message: "Cannot read content",
      })
    })

    it("handles empty messages array", () => {
      const result = mapWordMessages([])
      expect(result).toEqual([])
    })

    it("maps mixed messages", () => {
      const result = mapWordMessages([
        { type: "warning", message: "Warning 1" },
        { type: "error", message: "Error 1" },
        { type: "warning", message: "Warning 2" },
      ])

      expect(result).toHaveLength(3)
      expect(result[0].severity).toBe("warning")
      expect(result[1].severity).toBe("error")
      expect(result[2].severity).toBe("warning")
    })
  })

  describe("createBlockingDiagnostic", () => {
    it("creates diagnostic from Error instance", () => {
      const result = createBlockingDiagnostic("word", new Error("zip failure"))

      expect(result.code).toBe("parse_failed")
      expect(result.severity).toBe("error")
      expect(result.message).toContain("word")
      expect(result.message).toContain("zip failure")
    })

    it("creates diagnostic from string error", () => {
      const result = createBlockingDiagnostic("pdf", "unknown error")

      expect(result.code).toBe("parse_failed")
      expect(result.message).toContain("unknown error")
    })
  })

  describe("attachDiagnosticToError", () => {
    it("attaches diagnostic property to error", () => {
      const err = new Error("test error")
      const diagnostic = {
        code: "parse_failed" as const,
        severity: "error" as const,
        message: "failed",
      }

      const result = attachDiagnosticToError(err, diagnostic)

      expect(result).toBe(err)
      expect((result as Error & { diagnostic: unknown }).diagnostic).toEqual(diagnostic)
    })
  })
})
