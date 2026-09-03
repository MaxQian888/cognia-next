/**
 * @jest-environment jsdom
 */

import {
  ArtifactFrameCaptureError,
  captureArtifactFrame,
  hasArtifactFrameCapturer,
  registerArtifactFrameCapturer,
  __resetArtifactFrameCapturersForTests,
} from "./frame-capture-registry"

const snapshot = { html: "<!DOCTYPE html><html></html>", width: 800, height: 400 }

describe("frame capture registry", () => {
  beforeEach(() => __resetArtifactFrameCapturersForTests())

  it("returns null when no preview is mounted", async () => {
    // `null` rather than a throw: the caller raises the same "preview it first"
    // error it already raises for renderer types.
    expect(await captureArtifactFrame("missing")).toBeNull()
    expect(hasArtifactFrameCapturer("missing")).toBe(false)
  })

  it("routes a capture to the registered frame", async () => {
    registerArtifactFrameCapturer("a1", async () => snapshot)
    expect(hasArtifactFrameCapturer("a1")).toBe(true)
    expect(await captureArtifactFrame("a1")).toEqual(snapshot)
  })

  it("passes the caller's timeout through to the frame", async () => {
    let seen = 0
    registerArtifactFrameCapturer("a1", async (ms) => {
      seen = ms
      return snapshot
    })
    await captureArtifactFrame("a1", 1234)
    expect(seen).toBe(1234)
  })

  it("lets a remount replace the entry", async () => {
    registerArtifactFrameCapturer("a1", async () => snapshot)
    registerArtifactFrameCapturer("a1", async () => ({ ...snapshot, width: 999 }))
    expect((await captureArtifactFrame("a1"))?.width).toBe(999)
  })

  it("disposing a stale registration cannot unregister the live one", async () => {
    // The preview iframe is keyed, so a remount registers before the old
    // disposer runs. If that disposer won, the exporter would lose a frame
    // that is on screen.
    const disposeFirst = registerArtifactFrameCapturer("a1", async () => snapshot)
    registerArtifactFrameCapturer("a1", async () => ({ ...snapshot, width: 999 }))
    disposeFirst()
    expect(hasArtifactFrameCapturer("a1")).toBe(true)
    expect((await captureArtifactFrame("a1"))?.width).toBe(999)
  })

  it("stops answering once the preview unmounts", async () => {
    const dispose = registerArtifactFrameCapturer("a1", async () => snapshot)
    dispose()
    expect(await captureArtifactFrame("a1")).toBeNull()
  })

  it("propagates a frame-side failure", async () => {
    registerArtifactFrameCapturer("a1", async () => {
      throw new ArtifactFrameCaptureError("frame said no")
    })
    await expect(captureArtifactFrame("a1")).rejects.toBeInstanceOf(ArtifactFrameCaptureError)
  })
})
