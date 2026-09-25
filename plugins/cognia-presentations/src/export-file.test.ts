import { normalizeExportName, summarizeSave } from "./export-file"

describe("normalizeExportName", () => {
  it("forces the extension exactly once", () => {
    expect(normalizeExportName("report.pptx", "pptx", "presentation")).toBe("report.pptx")
    expect(normalizeExportName("report.PPTX", "pptx", "presentation")).toBe("report.pptx")
    expect(normalizeExportName("report", ".pptx", "presentation")).toBe("report.pptx")
    expect(normalizeExportName("notes.pdf", "pptx", "presentation")).toBe("notes.pdf.pptx")
  })

  it("strips path separators, reserved and control characters", () => {
    expect(normalizeExportName("a/b:c", "pptx", "presentation")).toBe("a-b-c.pptx")
    expect(normalizeExportName("..\\secret", "pptx", "presentation")).toBe("..-secret.pptx")
    expect(normalizeExportName("tab\there", "pptx", "presentation")).toBe("tab-here.pptx")
    expect(normalizeExportName("trailing. ", "pptx", "presentation")).toBe("trailing.pptx")
  })

  it("falls back when nothing usable remains and caps the length", () => {
    expect(normalizeExportName("", "pptx", "presentation")).toBe("presentation.pptx")
    expect(normalizeExportName(undefined, "pptx", "presentation")).toBe("presentation.pptx")
    expect(normalizeExportName("   ", "pptx", "presentation")).toBe("presentation.pptx")
    expect(normalizeExportName("x".repeat(300), "pptx", "presentation")).toHaveLength(125)
  })
})

describe("summarizeSave", () => {
  it("reports a cancelled save as not written", () => {
    expect(summarizeSave({ saved: false }, "a.pptx")).toEqual({
      ok: false,
      saved: false,
      cancelled: true,
      filename: "a.pptx",
      message: expect.stringContaining("not written"),
    })
  })

  it("tells the user where a mobile save landed", () => {
    const summary = summarizeSave(
      { saved: true, platform: "mobile", location: "file:///Documents/cognia/exports/a.pptx" },
      "a.pptx"
    )
    expect(summary).toMatchObject({ ok: true, saved: true, platform: "mobile" })
    expect(summary.location).toBe("file:///Documents/cognia/exports/a.pptx")
    expect(summary.message).toContain("Documents/cognia/exports")
    expect(summary.message).toContain("Files app")
  })

  it("describes web downloads and desktop dialogs", () => {
    expect(
      summarizeSave({ saved: true, platform: "web", location: "downloads" }, "a.pptx").message
    ).toContain("Downloads")
    expect(summarizeSave({ saved: true, platform: "desktop" }, "a.pptx").message).toContain(
      "save dialog"
    )
    expect(summarizeSave({ saved: true }, "a.pptx").message).toBe("Saved a.pptx.")
  })
})
