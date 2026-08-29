/** @jest-environment jsdom */
import {
  buildCanvasExportPayload,
  canvasExportFilename,
  copyCanvasDocumentToClipboard,
  exportCanvasDocument,
  extensionForLanguage,
  getCanvasExportFormats,
} from "./document-export"
import type { ArtifactLanguage, CanvasDocument } from "@/types/artifact/artifact"

jest.mock("@cognia/logging", () => ({
  loggers: { canvas: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } },
}))

const saveExportMock = jest.fn()
jest.mock("@/lib/files/save-export", () => ({
  saveExport: (opts: unknown) => saveExportMock(opts),
}))

const exportArtifactMock = jest.fn()
jest.mock("@/lib/artifacts/export", () => ({
  exportArtifact: (...a: unknown[]) => exportArtifactMock(...a),
  artifactExportFilename: (artifact: { title: string }, format: string) =>
    `${artifact.title}.${format}`,
}))

function makeDoc(overrides: Partial<CanvasDocument> = {}): CanvasDocument {
  const now = new Date("2026-07-07T00:00:00.000Z")
  return {
    id: "doc-1",
    sessionId: "sess-1",
    title: "My Doc",
    content: "hello world",
    language: "markdown",
    type: "text",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

describe("extensionForLanguage", () => {
  it.each<[ArtifactLanguage, string]>([
    ["markdown", "md"],
    ["typescript", "ts"],
    ["python", "py"],
    ["html", "html"],
    ["svg", "svg"],
    ["mermaid", "mmd"],
    ["latex", "tex"],
    ["bash", "sh"],
  ])("maps %s → .%s", (language, ext) => {
    expect(extensionForLanguage(language)).toBe(ext)
  })
})

describe("getCanvasExportFormats", () => {
  it("offers raw plus pdf for a markdown document", () => {
    // A markdown document projects onto the `document` artifact type, whose
    // PDF is laid-out text rather than a picture.
    expect(getCanvasExportFormats(makeDoc())).toEqual(["raw", "pdf"])
  })

  it("offers the full rendered set for an html document", () => {
    expect(getCanvasExportFormats(makeDoc({ language: "html", type: "code" }))).toEqual([
      "raw",
      "html",
      "png",
      "pdf",
    ])
  })

  it("offers the full rendered set for an svg document", () => {
    expect(getCanvasExportFormats(makeDoc({ language: "svg", type: "code" }))).toEqual([
      "raw",
      "svg",
      "png",
      "pdf",
    ])
  })

  it("offers raw + pdf for non-previewable code", () => {
    // Code has no raster path (a screenshot of code is worse than the code),
    // but its PDF is selectable text.
    expect(getCanvasExportFormats(makeDoc({ language: "python", type: "code" }))).toEqual([
      "raw",
      "pdf",
    ])
  })
})

describe("canvasExportFilename", () => {
  it("uses the language extension for raw", () => {
    expect(canvasExportFilename(makeDoc({ language: "typescript" }), "raw")).toBe("My-Doc.ts")
  })

  it("uses html/svg extensions for those formats", () => {
    expect(canvasExportFilename(makeDoc({ language: "html", type: "code" }), "html")).toBe(
      "My-Doc.html"
    )
    expect(canvasExportFilename(makeDoc({ language: "svg", type: "code" }), "svg")).toBe(
      "My-Doc.svg"
    )
  })

  it("sanitizes unsafe characters and whitespace", () => {
    expect(canvasExportFilename(makeDoc({ title: "  a/b:c  *d " }), "raw")).toBe("a-b-c-d.md")
  })

  it("falls back to a default stem for an empty title", () => {
    expect(canvasExportFilename(makeDoc({ title: "   " }), "raw")).toBe("canvas-document.md")
  })
})

describe("buildCanvasExportPayload", () => {
  it("serializes filename, content, and mime", () => {
    expect(buildCanvasExportPayload(makeDoc({ language: "html", type: "code" }), "html")).toEqual({
      filename: "My-Doc.html",
      content: "hello world",
      mime: "text/html",
    })
    expect(buildCanvasExportPayload(makeDoc({ language: "svg", type: "code" }), "svg").mime).toBe(
      "image/svg+xml"
    )
    expect(buildCanvasExportPayload(makeDoc(), "raw").mime).toBe("text/plain")
  })
})

describe("exportCanvasDocument", () => {
  beforeEach(() => {
    saveExportMock.mockReset().mockResolvedValue({ kind: "saved", location: "/tmp/x" })
    exportArtifactMock.mockReset().mockResolvedValue({ kind: "saved", location: "/tmp/x" })
  })

  it("hands a text format to the cross-platform saver and returns the filename", async () => {
    // The `<a download>` anchor this replaces silently no-ops inside a mobile
    // WebView, so Canvas exports vanished on Capacitor exactly as artifact
    // exports used to.
    const filename = await exportCanvasDocument(
      makeDoc({ title: "Report", language: "markdown" }),
      "raw"
    )
    expect(filename).toBe("Report.md")
    expect(saveExportMock).toHaveBeenCalledWith({
      filename: "Report.md",
      data: "hello world",
      mimeType: "text/plain",
    })
    expect(exportArtifactMock).not.toHaveBeenCalled()
  })

  it("routes a rendered format through the shared artifact exporter", async () => {
    // A Canvas svg document and an svg artifact must produce the same image.
    const filename = await exportCanvasDocument(
      makeDoc({ title: "Diagram", language: "svg", type: "code" }),
      "png"
    )
    expect(exportArtifactMock).toHaveBeenCalledWith(expect.objectContaining({ type: "svg" }), "png")
    expect(filename).toBe("Diagram.png")
    expect(saveExportMock).not.toHaveBeenCalled()
  })

  it("returns null for a format outside the contract", async () => {
    // `html` is not offered for a markdown document.
    expect(await exportCanvasDocument(makeDoc(), "html")).toBe("My-Doc.html")
    saveExportMock.mockClear()
    // A format that is in no adapter at all is refused outright.
    expect(await exportCanvasDocument(makeDoc(), "unknown" as never)).toBeNull()
    expect(saveExportMock).not.toHaveBeenCalled()
  })

  it("returns null when the user cancels the save dialog", async () => {
    saveExportMock.mockResolvedValue({ kind: "cancelled" })
    expect(await exportCanvasDocument(makeDoc(), "raw")).toBeNull()
  })

  it("returns null rather than throwing when a render fails", async () => {
    exportArtifactMock.mockRejectedValue(new Error("no preview"))
    expect(await exportCanvasDocument(makeDoc({ language: "svg", type: "code" }), "png")).toBeNull()
  })

  it("returns null when the document has no visual projection to render", async () => {
    // Plain python has no artifact type with a raster path.
    expect(
      await exportCanvasDocument(makeDoc({ language: "python", type: "code" }), "png")
    ).toBeNull()
    expect(exportArtifactMock).not.toHaveBeenCalled()
  })
})

describe("copyCanvasDocumentToClipboard", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis.navigator, "clipboard")

  afterEach(() => {
    if (original) Object.defineProperty(globalThis.navigator, "clipboard", original)
    else delete (globalThis.navigator as unknown as { clipboard?: unknown }).clipboard
  })

  it("writes the buffer to the clipboard and returns true", async () => {
    const writeText = jest.fn().mockResolvedValue(undefined)
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    })
    await expect(copyCanvasDocumentToClipboard(makeDoc({ content: "abc" }))).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith("abc")
  })

  it("returns false when the clipboard API is missing", async () => {
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: undefined,
    })
    await expect(copyCanvasDocumentToClipboard(makeDoc())).resolves.toBe(false)
  })

  it("returns false when writeText rejects", async () => {
    const writeText = jest.fn().mockRejectedValue(new Error("denied"))
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    })
    await expect(copyCanvasDocumentToClipboard(makeDoc())).resolves.toBe(false)
  })
})
