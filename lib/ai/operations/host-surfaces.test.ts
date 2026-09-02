/** @jest-environment node */
import { detectHostSurfaces } from "./host-surfaces"

describe("detectHostSurfaces", () => {
  it("is the sidecar surface without a window", () => {
    expect(typeof window).toBe("undefined")
    expect(detectHostSurfaces()).toEqual(["sidecar"])
  })
})
