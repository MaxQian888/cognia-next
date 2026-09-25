import { normalizeExportName, summarizeSave } from "./export-file"

describe("normalizeExportName", () => {
  it("forces the extension exactly once", () => {
    expect(normalizeExportName("report.pdf", "pdf", "document")).toBe("report.pdf")
    expect(normalizeExportName("report.PDF", "pdf", "document")).toBe("report.pdf")
    expect(normalizeExportName("report", ".pdf", "document")).toBe("report.pdf")
    expect(normalizeExportName("notes.docx", "pdf", "document")).toBe("notes.docx.pdf")
  })

  it("strips path separators, reserved and control characters", () => {
    expect(normalizeExportName("a/b:c", "pdf", "document")).toBe("a-b-c.pdf")
    expect(normalizeExportName("..\\secret", "pdf", "document")).toBe("..-secret.pdf")
    expect(normalizeExportName("tab\there", "pdf", "document")).toBe("tab-here.pdf")
    expect(normalizeExportName("trailing. ", "pdf", "document")).toBe("trailing.pdf")
  })

  it("falls back when nothing usable remains and caps the length", () => {
    expect(normalizeExportName("", "pdf", "document")).toBe("document.pdf")
    expect(normalizeExportName(undefined, "pdf", "document")).toBe("document.pdf")
    expect(normalizeExportName("   ", "pdf", "document")).toBe("document.pdf")
    expect(normalizeExportName("x".repeat(300), "pdf", "document")).toHaveLength(124)
  })
})

describe("summarizeSave", () => {
  it("reports a cancelled save as not written", () => {
    expect(summarizeSave({ saved: false }, "a.pdf")).toEqual({
      ok: false,
      saved: false,
      cancelled: true,
      filename: "a.pdf",
      message: expect.stringContaining("not written"),
    })
  })

  it("tells the user where a mobile save landed", () => {
    const summary = summarizeSave(
      { saved: true, platform: "mobile", location: "file:///Documents/cognia/exports/a.pdf" },
      "a.pdf"
    )
    expect(summary).toMatchObject({ ok: true, saved: true, platform: "mobile" })
    expect(summary.location).toBe("file:///Documents/cognia/exports/a.pdf")
    expect(summary.message).toContain("Documents/cognia/exports")
    expect(summary.message).toContain("Files app")
  })

  it("describes web downloads and desktop dialogs", () => {
    expect(
      summarizeSave({ saved: true, platform: "web", location: "downloads" }, "a.pdf").message
    ).toContain("Downloads")
    expect(summarizeSave({ saved: true, platform: "desktop" }, "a.pdf").message).toContain(
      "save dialog"
    )
    expect(summarizeSave({ saved: true }, "a.pdf").message).toBe("Saved a.pdf.")
  })
})
