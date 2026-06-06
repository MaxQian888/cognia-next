/**
 * Unit tests for the model→screen coordinate scaler. Pure module — no
 * transport or Tauri involvement.
 */

import {
  clearScalerTarget,
  modelToScreen,
  recordScreenshotDims,
  resetScalerState,
} from "./coordinate-scaler"

describe("coordinate-scaler", () => {
  beforeEach(() => resetScalerState())

  it("is identity when no screenshot was recorded", () => {
    expect(modelToScreen("local", [100, 200])).toEqual({ ok: true, x: 100, y: 200 })
  })

  it("is identity when the screenshot was not downscaled", () => {
    recordScreenshotDims("local", { width: 1920, height: 1080 })
    expect(modelToScreen("local", [960, 540])).toEqual({ ok: true, x: 960, y: 540 })
  })

  it("scales model coords up to source pixels", () => {
    recordScreenshotDims("local", {
      width: 1280,
      height: 720,
      sourceWidth: 2560,
      sourceHeight: 1440,
    })
    expect(modelToScreen("local", [640, 360])).toEqual({ ok: true, x: 1280, y: 720 })
    expect(modelToScreen("local", [0, 0])).toEqual({ ok: true, x: 0, y: 0 })
    expect(modelToScreen("local", [1280, 720])).toEqual({ ok: true, x: 2560, y: 1440 })
  })

  it("clamps slightly-out-of-edge coords instead of failing", () => {
    recordScreenshotDims("local", {
      width: 1280,
      height: 720,
      sourceWidth: 2560,
      sourceHeight: 1440,
    })
    // Within the 2px tolerance → clamped to the edge, not rejected.
    expect(modelToScreen("local", [1281, -1])).toEqual({ ok: true, x: 2560, y: 0 })
  })

  it("rejects clearly out-of-bounds model coords", () => {
    recordScreenshotDims("local", {
      width: 1280,
      height: 720,
      sourceWidth: 2560,
      sourceHeight: 1440,
    })
    const r = modelToScreen("local", [1500, 100])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("out of bounds")
  })

  it("keys state per capture target", () => {
    recordScreenshotDims("remote-1", {
      width: 100,
      height: 100,
      sourceWidth: 200,
      sourceHeight: 200,
    })
    expect(modelToScreen("local", [50, 50])).toEqual({ ok: true, x: 50, y: 50 })
    expect(modelToScreen("remote-1", [50, 50])).toEqual({ ok: true, x: 100, y: 100 })
  })

  it("clearScalerTarget drops a single target", () => {
    recordScreenshotDims("a", { width: 10, height: 10, sourceWidth: 20, sourceHeight: 20 })
    recordScreenshotDims("b", { width: 10, height: 10, sourceWidth: 40, sourceHeight: 40 })
    clearScalerTarget("a")
    expect(modelToScreen("a", [5, 5])).toEqual({ ok: true, x: 5, y: 5 })
    expect(modelToScreen("b", [5, 5])).toEqual({ ok: true, x: 20, y: 20 })
  })
})
