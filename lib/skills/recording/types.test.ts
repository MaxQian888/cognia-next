import { inlineScreenshotBytes } from "./types"
import type { Observation } from "./types"

function obs(screenshot: Observation["screenshot"]): Observation {
  return { seq: 1, tsMs: 0, kind: "click", screenshot }
}

describe("inlineScreenshotBytes", () => {
  it("returns base64 bytes for an inline screenshot", () => {
    const bytes = inlineScreenshotBytes(
      obs({
        kind: "inline",
        shot: { bytes: "ABC", width: 1, height: 1, capturedAt: 0, format: "png" },
      })
    )
    expect(bytes).toBe("ABC")
  })

  it("returns null for a file-backed screenshot", () => {
    const bytes = inlineScreenshotBytes(
      obs({ kind: "file", path: "x.png", width: 1, height: 1, capturedAt: 0 })
    )
    expect(bytes).toBeNull()
  })

  it("returns null when there is no screenshot", () => {
    expect(inlineScreenshotBytes(obs(undefined))).toBeNull()
  })
})
