import { normalizeExportName, summarizeSave } from "./export-file"

describe("normalizeExportName", () => {
  it("forces the extension exactly once", () => {
    expect(normalizeExportName("report.docx", "docx", "document")).toBe("report.docx")
    expect(normalizeExportName("report.DOCX", "docx", "document")).toBe("report.docx")
    expect(normalizeExportName("report", ".docx", "document")).toBe("report.docx")
    expect(normalizeExportName("notes.pdf", "docx", "document")).toBe("notes.pdf.docx")
  })

  it("strips path separators, reserved and control characters", () => {
    expect(normalizeExportName("a/b:c", "docx", "document")).toBe("a-b-c.docx")
    expect(normalizeExportName("..\\secret", "docx", "document")).toBe("..-secret.docx")
    expect(normalizeExportName("tab\there", "docx", "document")).toBe("tab-here.docx")
    expect(normalizeExportName("trailing. ", "docx", "document")).toBe("trailing.docx")
  })

  it("falls back when nothing usable remains and caps the length", () => {
    expect(normalizeExportName("", "docx", "document")).toBe("document.docx")
    expect(normalizeExportName(undefined, "docx", "document")).toBe("document.docx")
    expect(normalizeExportName("   ", "docx", "document")).toBe("document.docx")
    expect(normalizeExportName("x".repeat(300), "docx", "document")).toHaveLength(125)
  })
})

describe("summarizeSave", () => {
  it("reports a cancelled save as not written", () => {
    expect(summarizeSave({ saved: false }, "a.docx")).toEqual({
      ok: false,
      saved: false,
      cancelled: true,
      filename: "a.docx",
      message: expect.stringContaining("not written"),
    })
  })

  it("tells the user where a mobile save landed", () => {
    const summary = summarizeSave(
      { saved: true, platform: "mobile", location: "file:///Documents/cognia/exports/a.docx" },
      "a.docx"
    )
    expect(summary).toMatchObject({ ok: true, saved: true, platform: "mobile" })
    expect(summary.location).toBe("file:///Documents/cognia/exports/a.docx")
    expect(summary.message).toContain("Documents/cognia/exports")
    expect(summary.message).toContain("Files app")
  })

  it("describes web downloads and desktop dialogs", () => {
    expect(
      summarizeSave({ saved: true, platform: "web", location: "downloads" }, "a.docx").message
    ).toContain("Downloads")
    expect(summarizeSave({ saved: true, platform: "desktop" }, "a.docx").message).toContain(
      "save dialog"
    )
    expect(summarizeSave({ saved: true }, "a.docx").message).toBe("Saved a.docx.")
  })
})
