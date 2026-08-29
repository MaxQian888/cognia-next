/** @jest-environment jsdom */
const html2canvasMock = jest.fn()
jest.mock("html2canvas-pro", () => ({
  __esModule: true,
  default: (...args: unknown[]) => html2canvasMock(...args),
}))

import {
  ArtifactNotRasterisableError,
  ArtifactPreviewNotMountedError,
  ArtifactTooLargeToRasteriseError,
  MAX_PNG_HEIGHT_PX,
  renderArtifactToPngBlob,
} from "./raster"
import {
  clearArtifactPreviewNodes,
  registerArtifactPreviewNode,
} from "@/lib/artifacts/preview-registry"

function fakeCanvas(blob: Blob | null = new Blob(["png"], { type: "image/png" })) {
  return {
    toBlob: (cb: (b: Blob | null) => void) => cb(blob),
  } as unknown as HTMLCanvasElement
}

beforeEach(() => {
  html2canvasMock.mockReset().mockResolvedValue(fakeCanvas())
  clearArtifactPreviewNodes()
  document.body.innerHTML = ""
})

describe("renderArtifactToPngBlob — renderer transports", () => {
  const chart = { id: "a1", type: "chart" as const, content: "{}" }

  it("captures the mounted preview node", async () => {
    const node = document.createElement("div")
    document.body.appendChild(node)
    registerArtifactPreviewNode("a1", node)

    const blob = await renderArtifactToPngBlob(chart)

    expect(blob.type).toBe("image/png")
    expect(html2canvasMock).toHaveBeenCalledWith(node, expect.objectContaining({ scale: 2 }))
  })

  it("refuses with a typed error when the preview is not mounted", async () => {
    // Recharts draws live React; with nothing on screen there are no pixels.
    // "Preview it first" and "too large" are different user problems, so they
    // must not collapse into one opaque failure.
    await expect(renderArtifactToPngBlob(chart)).rejects.toBeInstanceOf(
      ArtifactPreviewNotMountedError
    )
    expect(html2canvasMock).not.toHaveBeenCalled()
  })

  it("treats a detached node as not mounted", async () => {
    const node = document.createElement("div")
    document.body.appendChild(node)
    registerArtifactPreviewNode("a1", node)
    node.remove()
    await expect(renderArtifactToPngBlob(chart)).rejects.toBeInstanceOf(
      ArtifactPreviewNotMountedError
    )
  })

  it("refuses a node taller than a canvas can hold", async () => {
    const node = document.createElement("div")
    document.body.appendChild(node)
    Object.defineProperty(node, "scrollHeight", { value: MAX_PNG_HEIGHT_PX + 1 })
    registerArtifactPreviewNode("a1", node)
    await expect(renderArtifactToPngBlob(chart)).rejects.toBeInstanceOf(
      ArtifactTooLargeToRasteriseError
    )
  })

  it("surfaces a null toBlob rather than resolving an empty file", async () => {
    const node = document.createElement("div")
    document.body.appendChild(node)
    registerArtifactPreviewNode("a1", node)
    html2canvasMock.mockResolvedValue(fakeCanvas(null))
    await expect(renderArtifactToPngBlob(chart)).rejects.toThrow("toBlob")
  })
})

describe("renderArtifactToPngBlob — iframe transports", () => {
  it("captures html through an off-screen frame, not the sandboxed preview", async () => {
    // html2canvas walks the DOM and cannot reach into the preview's sandboxed
    // frame (`allow-scripts`, no `allow-same-origin`), which is why this
    // indirection exists at all.
    const promise = renderArtifactToPngBlob({
      id: "a2",
      type: "html",
      content: "<p>hello</p>",
    })
    const frame = document.querySelector("iframe") as HTMLIFrameElement
    expect(frame).not.toBeNull()
    expect(frame.getAttribute("sandbox")).toBeNull()
    frame.dispatchEvent(new Event("load"))

    const blob = await promise
    expect(blob.type).toBe("image/png")
    // …and the scratch frame is cleaned up.
    expect(document.querySelector("iframe")).toBeNull()
  })

  it("removes the scratch frame even when the capture throws", async () => {
    html2canvasMock.mockRejectedValue(new Error("boom"))
    const promise = renderArtifactToPngBlob({ id: "a2", type: "html", content: "<p>x</p>" })
    ;(document.querySelector("iframe") as HTMLIFrameElement).dispatchEvent(new Event("load"))
    await expect(promise).rejects.toThrow("boom")
    expect(document.querySelector("iframe")).toBeNull()
  })

  it("strips scripts from the captured html", async () => {
    const promise = renderArtifactToPngBlob({
      id: "a2",
      type: "html",
      content: "<p>ok</p><script>fetch('https://evil.test')</script>",
    })
    const frame = document.querySelector("iframe") as HTMLIFrameElement
    // The frame is deliberately NOT sandboxed so html2canvas can read it;
    // sanitisation is what makes that safe.
    expect(frame.srcdoc).not.toContain("<script")
    frame.dispatchEvent(new Event("load"))
    await promise
  })
})

describe("renderArtifactToPngBlob — unsupported transports", () => {
  it("refuses a jupyter artifact, which has no rendered form here", async () => {
    await expect(
      renderArtifactToPngBlob({ id: "a3", type: "jupyter", content: "{}" })
    ).rejects.toBeInstanceOf(ArtifactNotRasterisableError)
  })
})
