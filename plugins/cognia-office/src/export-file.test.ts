import { normalizeExportName, summarizeSave } from "./export-file"

describe("normalizeExportName", () => {
  it("forces the extension exactly once", () => {
    expect(normalizeExportName("report.xlsx", "xlsx", "workbook")).toBe("report.xlsx")
    expect(normalizeExportName("report.XLSX", "xlsx", "workbook")).toBe("report.xlsx")
    expect(normalizeExportName("report", ".xlsx", "workbook")).toBe("report.xlsx")
    expect(normalizeExportName("notes.pdf", "xlsx", "workbook")).toBe("notes.pdf.xlsx")
  })

  it("strips path separators, reserved and control characters", () => {
    expect(normalizeExportName("a/b:c", "xlsx", "workbook")).toBe("a-b-c.xlsx")
    expect(normalizeExportName("..\\secret", "xlsx", "workbook")).toBe("..-secret.xlsx")
    expect(normalizeExportName("tab\there", "xlsx", "workbook")).toBe("tab-here.xlsx")
    expect(normalizeExportName("trailing. ", "xlsx", "workbook")).toBe("trailing.xlsx")
  })

  it("falls back when nothing usable remains and caps the length", () => {
    expect(normalizeExportName("", "xlsx", "workbook")).toBe("workbook.xlsx")
    expect(normalizeExportName(undefined, "xlsx", "workbook")).toBe("workbook.xlsx")
    expect(normalizeExportName("   ", "xlsx", "workbook")).toBe("workbook.xlsx")
    expect(normalizeExportName("x".repeat(300), "xlsx", "workbook")).toHaveLength(125)
  })
})

describe("summarizeSave", () => {
  it("reports a cancelled save as not written", () => {
    expect(summarizeSave({ saved: false }, "a.xlsx")).toEqual({
      ok: false,
      saved: false,
      cancelled: true,
      filename: "a.xlsx",
      message: expect.stringContaining("not written"),
    })
  })

  it("tells the user where a mobile save landed", () => {
    const summary = summarizeSave(
      { saved: true, platform: "mobile", location: "file:///Documents/cognia/exports/a.xlsx" },
      "a.xlsx"
    )
    expect(summary).toMatchObject({ ok: true, saved: true, platform: "mobile" })
    expect(summary.location).toBe("file:///Documents/cognia/exports/a.xlsx")
    expect(summary.message).toContain("Documents/cognia/exports")
    expect(summary.message).toContain("Files app")
  })

  it("describes web downloads and desktop dialogs", () => {
    expect(
      summarizeSave({ saved: true, platform: "web", location: "downloads" }, "a.xlsx").message
    ).toContain("Downloads")
    expect(summarizeSave({ saved: true, platform: "desktop" }, "a.xlsx").message).toContain(
      "save dialog"
    )
    expect(summarizeSave({ saved: true }, "a.xlsx").message).toBe("Saved a.xlsx.")
  })
})
