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
  it("offers only raw for a markdown document", () => {
    expect(getCanvasExportFormats(makeDoc())).toEqual(["raw"])
  })

  it("offers raw + html for an html document", () => {
    expect(getCanvasExportFormats(makeDoc({ language: "html", type: "code" }))).toEqual([
      "raw",
      "html",
    ])
  })

  it("offers raw + svg for an svg document", () => {
    expect(getCanvasExportFormats(makeDoc({ language: "svg", type: "code" }))).toEqual([
      "raw",
      "svg",
    ])
  })

  it("offers only raw for non-previewable code", () => {
    expect(getCanvasExportFormats(makeDoc({ language: "python", type: "code" }))).toEqual(["raw"])
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
  let created: HTMLAnchorElement[]
  let createSpy: jest.SpyInstance

  beforeEach(() => {
    created = []
    const realCreate = document.createElement.bind(document)
    createSpy = jest
      .spyOn(document, "createElement")
      .mockImplementation((tag: string, ...rest: unknown[]) => {
        const el = realCreate(tag as "a", ...(rest as [])) as HTMLElement
        if (tag === "a") {
          jest.spyOn(el as HTMLAnchorElement, "click").mockImplementation(() => {})
          created.push(el as HTMLAnchorElement)
        }
        return el
      })
  })

  afterEach(() => {
    createSpy.mockRestore()
    // Reset any URL mocks set within a test.
    delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL
    delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL
  })

  it("triggers a download via an object URL and returns the filename", () => {
    const createObjectURL = jest.fn(() => "blob:mock-url")
    const revokeObjectURL = jest.fn()
    ;(URL as unknown as { createObjectURL: unknown }).createObjectURL = createObjectURL
    ;(URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = revokeObjectURL

    const filename = exportCanvasDocument(makeDoc({ title: "Report", language: "markdown" }), "raw")

    expect(filename).toBe("Report.md")
    expect(created).toHaveLength(1)
    expect(created[0].download).toBe("Report.md")
    expect(created[0].getAttribute("href")).toBe("blob:mock-url")
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url")
  })

  it("falls back to a data URL when createObjectURL is unavailable", () => {
    // No URL.createObjectURL set (deleted in afterEach of prior test / default).
    const filename = exportCanvasDocument(makeDoc({ language: "html", type: "code" }), "html")
    expect(filename).toBe("My-Doc.html")
    expect(created[0].getAttribute("href")).toMatch(/^data:text\/html/)
  })

  it("returns null and does not download for an unsupported format", () => {
    const filename = exportCanvasDocument(makeDoc(), "png")
    expect(filename).toBeNull()
    expect(created).toHaveLength(0)
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
