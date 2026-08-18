import {
  MAX_BITABLE_ROWS,
  MAX_BITABLE_TABLES,
  MAX_DOC_CHARS,
  MAX_SHEET_COLS,
  MAX_SHEET_ROWS,
  MAX_SHEET_TABS,
  clampDocText,
  truncationMarker,
} from "./limits"

describe("docs-provider limits", () => {
  it("keeps every cap positive and finite", () => {
    for (const cap of [
      MAX_SHEET_ROWS,
      MAX_SHEET_TABS,
      MAX_SHEET_COLS,
      MAX_BITABLE_TABLES,
      MAX_BITABLE_ROWS,
      MAX_DOC_CHARS,
    ]) {
      expect(Number.isFinite(cap)).toBe(true)
      expect(cap).toBeGreaterThan(0)
    }
  })

  it("names what was cut, how much was kept, and the unit", () => {
    const marker = truncationMarker("table “Tasks”", 200, "rows")
    expect(marker).toContain("table “Tasks”")
    expect(marker).toContain("200")
    expect(marker).toContain("rows")
  })

  describe("clampDocText", () => {
    it("leaves a body under the cap untouched and unflagged", () => {
      const text = "hello world"
      expect(clampDocText(text)).toEqual({ text, truncated: false })
    })

    it("leaves a body exactly at the cap untouched", () => {
      const text = "x".repeat(MAX_DOC_CHARS)
      expect(clampDocText(text)).toEqual({ text, truncated: false })
    })

    it("never truncates silently — the flag and the in-body marker come together", () => {
      const result = clampDocText("x".repeat(MAX_DOC_CHARS + 1))
      expect(result.truncated).toBe(true)
      expect(result.text).toContain("Truncated by Cognia")
      expect(result.text.startsWith("x".repeat(MAX_DOC_CHARS))).toBe(true)
    })
  })
})
