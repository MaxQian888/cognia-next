/** @jest-environment jsdom */
import { paneCenterScreenPoint } from "./pane-center"

describe("paneCenterScreenPoint", () => {
  it("returns the centre of the supplied pane rect (client coords)", () => {
    expect(paneCenterScreenPoint({ left: 320, top: 48, width: 800, height: 600 })).toEqual({
      x: 720,
      y: 348,
    })
  })

  it("ignores a left-shifted pane correctly (centre is rect-relative, not window)", () => {
    // Pane offset 320px from the left (sidebar) → centre must sit inside the
    // pane, NOT at window.innerWidth/2.
    const rect = { left: 320, top: 0, width: 600, height: 400 }
    expect(paneCenterScreenPoint(rect)).toEqual({ x: 620, y: 200 })
  })

  it("falls back to the window centre when no rect is available", () => {
    Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true })
    Object.defineProperty(window, "innerHeight", { value: 768, configurable: true })
    expect(paneCenterScreenPoint(null)).toEqual({ x: 512, y: 384 })
    expect(paneCenterScreenPoint(undefined)).toEqual({ x: 512, y: 384 })
  })
})
