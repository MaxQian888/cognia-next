import manifestJson from "../plugin.json"
import {
  ALL_DELIVERABLE_FORMATS,
  DELIVERABLE_FORMATS,
  DELIVERABLE_KINDS,
  DOCUMENTS_DOCX_WRITER,
  NATIVE_DELIVERABLE_WRITERS,
  nativeWriterFor,
  OFFICE_WORKBOOK_WRITER,
  resolveDeliverable,
} from "./deliverables"

describe("resolveDeliverable", () => {
  it("defaults every kind to its first format", () => {
    expect(resolveDeliverable("document")).toMatchObject({
      format: "markdown",
      target: { writer: "artifact", language: "markdown" },
    })
    expect(resolveDeliverable("spreadsheet")).toEqual({
      format: "xlsx",
      target: OFFICE_WORKBOOK_WRITER,
    })
    expect(resolveDeliverable("site")).toMatchObject({
      format: "html",
      target: { writer: "artifact", type: "html", previewable: true },
    })
  })

  it("routes docx documents and reports to cognia-documents", () => {
    for (const kind of ["document", "report"] as const)
      expect(resolveDeliverable(kind, "docx")).toEqual({
        format: "docx",
        target: DOCUMENTS_DOCX_WRITER,
      })
  })

  it("refuses formats a kind cannot be written in and unknown kinds", () => {
    expect(() => resolveDeliverable("presentation", "docx")).toThrow(
      "a presentation deliverable cannot be docx; use html"
    )
    expect(() => resolveDeliverable("memo" as never)).toThrow("unsupported deliverable kind")
  })

  it("covers every kind and format in the tool enums", () => {
    expect(Object.keys(DELIVERABLE_FORMATS).sort()).toEqual([...DELIVERABLE_KINDS].sort())
    expect(new Set(Object.values(DELIVERABLE_FORMATS).flat())).toEqual(
      new Set(ALL_DELIVERABLE_FORMATS)
    )
  })
})

describe("native writers", () => {
  it("only name plugins the manifest declares as dependencies", () => {
    for (const writer of NATIVE_DELIVERABLE_WRITERS)
      expect(manifestJson.dependencies).toHaveProperty(writer.pluginId)
  })

  it("map each writer's create and read contracts", () => {
    expect(OFFICE_WORKBOOK_WRITER.create.args({ title: "T", content: "a,b" })).toEqual({
      title: "T",
      content: "a,b",
    })
    expect(DOCUMENTS_DOCX_WRITER.create.args({ title: "T", content: "# H" })).toEqual({
      title: "T",
      markdown: "# H",
    })
    expect(OFFICE_WORKBOOK_WRITER.read.text({ text: "grid", truncated: true })).toEqual({
      text: "grid",
      truncated: true,
    })
    expect(DOCUMENTS_DOCX_WRITER.read.text({ markdown: "# H" })).toEqual({
      text: "# H",
      truncated: false,
    })
    expect(() => OFFICE_WORKBOOK_WRITER.read.text(null)).toThrow("returned no text")
  })

  it("finds the writer that owns an artifact by its plugin kind", () => {
    expect(
      nativeWriterFor({
        metadata: {
          plugin: {
            kind: "cognia-documents/document",
            schemaVersion: 1,
            ownerPluginId: "cognia-documents",
          },
        },
      })
    ).toBe(DOCUMENTS_DOCX_WRITER)
    expect(nativeWriterFor({ metadata: {} })).toBeUndefined()
    expect(
      nativeWriterFor({
        metadata: {
          plugin: { kind: "cognia-work-mode/artifact", schemaVersion: 1, ownerPluginId: "x" },
        },
      })
    ).toBeUndefined()
  })
})
