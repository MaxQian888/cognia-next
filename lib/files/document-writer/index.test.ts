/**
 * @jest-environment jsdom
 */
jest.mock("docx", () => ({
  Document: jest.fn(),
  Packer: { toBlob: jest.fn(async () => new Blob(["docx"], { type: "application/octet-stream" })) },
  Paragraph: jest.fn(),
  TextRun: jest.fn(),
  HeadingLevel: { HEADING_1: "h1", HEADING_2: "h2", HEADING_3: "h3" },
}))

jest.mock("jspdf", () => ({
  jsPDF: jest.fn().mockImplementation(() => ({
    internal: { pageSize: { getHeight: () => 800, getWidth: () => 600 } },
    setFontSize: jest.fn(),
    setFont: jest.fn(),
    splitTextToSize: (t: string) => [t],
    text: jest.fn(),
    addPage: jest.fn(),
    output: jest.fn(() => new Blob(["pdf"], { type: "application/pdf" })),
  })),
}))

const saveExportMock = jest.fn(
  async (_o?: unknown): Promise<{ kind: string; [k: string]: unknown }> => ({
    kind: "saved",
    platform: "mobile",
    location: "file://x",
    filename: "f",
  })
)
jest.mock("@/lib/files/save-export", () => ({ saveExport: (o: unknown) => saveExportMock(o) }))

import { Packer } from "docx"
import { jsPDF } from "jspdf"

import { generateDocument, saveGeneratedDocument } from "./index"

beforeEach(() => jest.clearAllMocks())

const markdown = "# Title\n\nHello world\n\n- one\n- two\n\n```\ncode()\n```"

describe("generateDocument", () => {
  it("renders a .docx with the Word mime type and sanitized filename", async () => {
    const out = await generateDocument({ title: "My/Report:1", markdown, format: "docx" })
    expect(Packer.toBlob).toHaveBeenCalled()
    expect(out.mimeType).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    )
    expect(out.filename).toBe("My Report 1.docx")
    expect(out.data).toBeInstanceOf(Blob)
  })

  it("renders a .pdf via jsPDF", async () => {
    const out = await generateDocument({ title: "Doc", markdown, format: "pdf" })
    expect(jsPDF).toHaveBeenCalled()
    expect(out.mimeType).toBe("application/pdf")
    expect(out.filename).toBe("Doc.pdf")
  })

  it("falls back to a default filename for an empty title", async () => {
    const out = await generateDocument({ title: "   ", markdown: "x", format: "pdf" })
    expect(out.filename).toBe("document.pdf")
  })

  it("renders every block kind and heading level into the .docx", async () => {
    const md = "# H1\n## H2\n### H3\n\npara\n\n- item\n\n```\ncode\n```"
    await generateDocument({ title: "All", markdown: md, format: "docx" })
    expect(Packer.toBlob).toHaveBeenCalled()
  })

  it("paginates the PDF when content overflows the page height", async () => {
    // Force a tiny page so every line triggers addPage().
    const addPage = jest.fn()
    ;(jsPDF as unknown as jest.Mock).mockImplementationOnce(() => ({
      internal: { pageSize: { getHeight: () => 20, getWidth: () => 600 } },
      setFontSize: jest.fn(),
      setFont: jest.fn(),
      splitTextToSize: (t: string) => [t, t],
      text: jest.fn(),
      addPage,
      output: () => new Blob(["pdf"], { type: "application/pdf" }),
    }))
    const md = "# Title\npara one\n- bullet\n\n```\ncode\n```"
    await generateDocument({ title: "Long", markdown: md, format: "pdf" })
    expect(addPage).toHaveBeenCalled()
  })
})

describe("saveGeneratedDocument", () => {
  it("generates then saves via the cross-platform saveExport", async () => {
    await saveGeneratedDocument({ title: "Notes", markdown, format: "docx" })
    expect(saveExportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: "Notes.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      })
    )
  })
})
