/** @jest-environment jsdom */
const generateDocumentMock = jest.fn()
jest.mock("@/lib/files/document-writer", () => ({
  generateDocument: (opts: unknown) => generateDocumentMock(opts),
}))

const renderPngMock = jest.fn()
jest.mock("./raster", () => ({
  renderArtifactToPngBlob: (...args: unknown[]) => renderPngMock(...args),
}))

const addImageMock = jest.fn()
const outputMock = jest.fn(() => new Blob(["pdf"], { type: "application/pdf" }))
const jsPDFMock = jest.fn()
jest.mock("jspdf", () => ({
  jsPDF: class {
    constructor(opts: unknown) {
      jsPDFMock(opts)
    }
    addImage = addImageMock
    output = outputMock
  },
}))

import { renderArtifactToPdfBlob } from "./pdf"

// jsdom does not decode images; stand in for the natural-size read.
let imageSize = { width: 800, height: 400 }
beforeAll(() => {
  Object.defineProperty(HTMLImageElement.prototype, "src", {
    set(this: HTMLImageElement) {
      Object.defineProperty(this, "naturalWidth", { value: imageSize.width, configurable: true })
      Object.defineProperty(this, "naturalHeight", { value: imageSize.height, configurable: true })
      setTimeout(() => this.dispatchEvent(new Event("load")), 0)
    },
    configurable: true,
  })
})

beforeEach(() => {
  generateDocumentMock.mockReset().mockResolvedValue({
    data: new Blob(["doc"], { type: "application/pdf" }),
    mimeType: "application/pdf",
    filename: "x.pdf",
  })
  renderPngMock.mockReset().mockResolvedValue(new Blob(["png"], { type: "image/png" }))
  addImageMock.mockClear()
  jsPDFMock.mockClear()
  imageSize = { width: 800, height: 400 }
})

describe("text-shaped artifacts", () => {
  it.each(["document", "code", "jupyter"] as const)(
    "lays %s out as selectable text instead of a picture of itself",
    async (type) => {
      await renderArtifactToPdfBlob({ id: "a", type, title: "T", content: "# hi" })
      expect(generateDocumentMock).toHaveBeenCalledWith({
        title: "T",
        markdown: "# hi",
        format: "pdf",
      })
      expect(renderPngMock).not.toHaveBeenCalled()
    }
  )

  it("falls back to a stable title when the artifact has none", async () => {
    await renderArtifactToPdfBlob({ id: "a", type: "document", title: "", content: "x" })
    expect(generateDocumentMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: "artifact" })
    )
  })
})

describe("visual artifacts", () => {
  it("rasterises on a white sheet — a transparent PNG prints unpredictably", async () => {
    await renderArtifactToPdfBlob({ id: "a", type: "chart", title: "T", content: "{}" })
    expect(renderPngMock).toHaveBeenCalledWith(expect.objectContaining({ type: "chart" }), {
      background: "#ffffff",
    })
    expect(generateDocumentMock).not.toHaveBeenCalled()
  })

  it("turns the page landscape for an image that is wider than tall", async () => {
    imageSize = { width: 1200, height: 400 }
    await renderArtifactToPdfBlob({ id: "a", type: "chart", title: "T", content: "{}" })
    expect(jsPDFMock).toHaveBeenCalledWith(expect.objectContaining({ orientation: "landscape" }))
  })

  it("keeps portrait for a tall image", async () => {
    imageSize = { width: 400, height: 1200 }
    await renderArtifactToPdfBlob({ id: "a", type: "mermaid", title: "T", content: "graph TD" })
    expect(jsPDFMock).toHaveBeenCalledWith(expect.objectContaining({ orientation: "portrait" }))
  })

  it("never upscales a small image past its natural size", async () => {
    imageSize = { width: 100, height: 50 }
    await renderArtifactToPdfBlob({ id: "a", type: "chart", title: "T", content: "{}" })
    const [, , , , width, height] = addImageMock.mock.calls[0]
    expect(width).toBe(100)
    expect(height).toBe(50)
  })

  it("scales a large image down to fit inside the page margins", async () => {
    imageSize = { width: 4000, height: 2000 }
    await renderArtifactToPdfBlob({ id: "a", type: "chart", title: "T", content: "{}" })
    const [, , x, y, width, height] = addImageMock.mock.calls[0]
    // Landscape A4 is 841.89 x 595.28pt with a 36pt margin on each side.
    expect(width).toBeLessThanOrEqual(841.89 - 72)
    expect(height).toBeLessThanOrEqual(595.28 - 72)
    expect(width / height).toBeCloseTo(2, 5)
    expect(x).toBeGreaterThan(0)
    expect(y).toBeGreaterThan(0)
  })
})
