/** @jest-environment jsdom */
const saveExportMock = jest.fn()
jest.mock("@/lib/files/save-export", () => ({
  saveExport: (opts: unknown) => saveExportMock(opts),
}))

const renderPngMock = jest.fn()
jest.mock("./raster", () => ({
  renderArtifactToPngBlob: (...a: unknown[]) => renderPngMock(...a),
  ArtifactNotRasterisableError: class extends Error {},
  ArtifactPreviewNotMountedError: class extends Error {},
  ArtifactTooLargeToRasteriseError: class extends Error {},
}))

const renderPdfMock = jest.fn()
jest.mock("./pdf", () => ({
  renderArtifactToPdfBlob: (...a: unknown[]) => renderPdfMock(...a),
}))

import {
  UnsupportedArtifactExportError,
  artifactExportFilename,
  exportArtifact,
  renderArtifactExport,
} from "./index"
import type { Artifact } from "@/types"

const artifact = (over: Partial<Artifact> = {}) =>
  ({
    id: "a1",
    type: "chart",
    title: "Q4 revenue",
    content: '{"type":"bar"}',
    ...over,
  }) as Artifact

beforeEach(() => {
  saveExportMock.mockReset().mockResolvedValue({ kind: "saved", location: "/tmp/x" })
  renderPngMock.mockReset().mockResolvedValue(new Blob(["png"], { type: "image/png" }))
  renderPdfMock.mockReset().mockResolvedValue(new Blob(["pdf"], { type: "application/pdf" }))
})

describe("artifactExportFilename", () => {
  it("uses the artifact's own extension for raw", () => {
    expect(artifactExportFilename(artifact({ type: "mermaid" }), "raw")).toBe("Q4 revenue.mmd")
  })

  it("uses the format as the extension for a rendered export", () => {
    // The old chat-side download used `.${artifact.type}`, so a chart came out
    // as `chart.chart`.
    expect(artifactExportFilename(artifact(), "png")).toBe("Q4 revenue.png")
    expect(artifactExportFilename(artifact(), "pdf")).toBe("Q4 revenue.pdf")
  })

  it("strips characters a filename cannot carry", () => {
    expect(artifactExportFilename(artifact({ title: 'a/b:c*d?"e<f>g|h' }), "png")).toBe(
      "a b c d e f g h.png"
    )
  })

  it("falls back to a usable name when the title is empty or only separators", () => {
    expect(artifactExportFilename(artifact({ title: "" }), "png")).toBe("artifact.png")
    expect(artifactExportFilename(artifact({ title: "///" }), "png")).toBe("artifact.png")
  })
})

describe("renderArtifactExport", () => {
  it("returns the source text for raw, without loading a renderer", async () => {
    const out = await renderArtifactExport(
      artifact({ type: "code", language: "typescript" }),
      "raw"
    )
    expect(out.data).toBe('{"type":"bar"}')
    expect(out.mimeType).toBe("text/plain;charset=utf-8")
    expect(renderPngMock).not.toHaveBeenCalled()
    expect(renderPdfMock).not.toHaveBeenCalled()
  })

  it("routes png through the raster renderer", async () => {
    const out = await renderArtifactExport(artifact(), "png")
    expect(renderPngMock).toHaveBeenCalled()
    expect(out.mimeType).toBe("image/png")
  })

  it("routes pdf through the pdf renderer", async () => {
    const out = await renderArtifactExport(artifact(), "pdf")
    expect(renderPdfMock).toHaveBeenCalled()
    expect(out.mimeType).toBe("application/pdf")
  })

  it("refuses a format the artifact's adapter does not offer", async () => {
    // `react` deliberately offers `raw` only: its off-screen capture would be
    // blank, so offering png would produce an empty file, not an error.
    await expect(renderArtifactExport(artifact({ type: "react" }), "png")).rejects.toBeInstanceOf(
      UnsupportedArtifactExportError
    )
    expect(renderPngMock).not.toHaveBeenCalled()
  })

  it("honours a metadata narrowing of the adapter's formats", async () => {
    await expect(
      renderArtifactExport(artifact({ metadata: { exportFormats: ["raw"] } }), "png")
    ).rejects.toBeInstanceOf(UnsupportedArtifactExportError)
  })
})

describe("exportArtifact", () => {
  it("hands the rendered bytes to the cross-platform saver", async () => {
    const outcome = await exportArtifact(artifact(), "png")
    expect(saveExportMock).toHaveBeenCalledWith({
      filename: "Q4 revenue.png",
      data: expect.any(Blob),
      mimeType: "image/png",
    })
    expect(outcome).toEqual({ kind: "saved", location: "/tmp/x" })
  })

  it("propagates a cancelled save rather than reporting success", async () => {
    saveExportMock.mockResolvedValue({ kind: "cancelled" })
    await expect(exportArtifact(artifact(), "raw")).resolves.toEqual({ kind: "cancelled" })
  })

  it("does not reach the saver when rendering fails", async () => {
    renderPngMock.mockRejectedValue(new Error("no preview"))
    await expect(exportArtifact(artifact(), "png")).rejects.toThrow("no preview")
    expect(saveExportMock).not.toHaveBeenCalled()
  })
})
