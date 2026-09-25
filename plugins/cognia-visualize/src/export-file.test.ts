import { normalizeExportName, summarizeSave } from "./export-file"

describe("normalizeExportName", () => {
  it("forces the extension exactly once", () => {
    expect(normalizeExportName("report.html", "html", "visualization")).toBe("report.html")
    expect(normalizeExportName("report.HTML", "html", "visualization")).toBe("report.html")
    expect(normalizeExportName("report", ".html", "visualization")).toBe("report.html")
    expect(normalizeExportName("notes.pdf", "html", "visualization")).toBe("notes.pdf.html")
  })

  it("strips path separators, reserved and control characters", () => {
    expect(normalizeExportName("a/b:c", "html", "visualization")).toBe("a-b-c.html")
    expect(normalizeExportName("..\\secret", "html", "visualization")).toBe("..-secret.html")
    expect(normalizeExportName("tab\there", "html", "visualization")).toBe("tab-here.html")
    expect(normalizeExportName("trailing. ", "html", "visualization")).toBe("trailing.html")
  })

  it("falls back when nothing usable remains and caps the length", () => {
    expect(normalizeExportName("", "html", "visualization")).toBe("visualization.html")
    expect(normalizeExportName(undefined, "html", "visualization")).toBe("visualization.html")
    expect(normalizeExportName("   ", "html", "visualization")).toBe("visualization.html")
    expect(normalizeExportName("x".repeat(300), "html", "visualization")).toHaveLength(125)
  })
})

describe("summarizeSave", () => {
  it("reports a cancelled save as not written", () => {
    expect(summarizeSave({ saved: false }, "a.html")).toEqual({
      ok: false,
      saved: false,
      cancelled: true,
      filename: "a.html",
      message: expect.stringContaining("not written"),
    })
  })

  it("tells the user where a mobile save landed", () => {
    const summary = summarizeSave(
      { saved: true, platform: "mobile", location: "file:///Documents/cognia/exports/a.html" },
      "a.html"
    )
    expect(summary).toMatchObject({ ok: true, saved: true, platform: "mobile" })
    expect(summary.location).toBe("file:///Documents/cognia/exports/a.html")
    expect(summary.message).toContain("Documents/cognia/exports")
    expect(summary.message).toContain("Files app")
  })

  it("describes web downloads and desktop dialogs", () => {
    expect(
      summarizeSave({ saved: true, platform: "web", location: "downloads" }, "a.html").message
    ).toContain("Downloads")
    expect(summarizeSave({ saved: true, platform: "desktop" }, "a.html").message).toContain(
      "save dialog"
    )
    expect(summarizeSave({ saved: true }, "a.html").message).toBe("Saved a.html.")
  })
})
