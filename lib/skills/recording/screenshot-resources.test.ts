import { buildScreenshotResources, MAX_SCREENSHOT_RESOURCES } from "./screenshot-resources"
import type { Observation, RecordingTrace } from "./types"

function inlineShot(seq: number, bytes: string): Observation {
  return {
    seq,
    tsMs: seq,
    kind: "click",
    screenshot: {
      kind: "inline",
      shot: { bytes, width: 1, height: 1, capturedAt: 0, format: "png" },
    },
  }
}

function trace(observations: Observation[]): RecordingTrace {
  return { sessionId: "s", startedAt: 0, endedAt: 1, observations, monitors: [] }
}

describe("buildScreenshotResources", () => {
  it("projects inline screenshots into asset resources", () => {
    const resources = buildScreenshotResources(
      trace([inlineShot(1, "AAAA"), inlineShot(2, "BBBB")])
    )
    expect(resources).toHaveLength(2)
    expect(resources[0]).toMatchObject({
      kind: "asset",
      path: "assets/step-01.png",
      content: "AAAA",
      encoding: "base64",
      mimeType: "image/png",
    })
    expect(resources[1].path).toBe("assets/step-02.png")
  })

  it("skips observations without an inline screenshot", () => {
    const obs: Observation[] = [
      { seq: 1, tsMs: 0, kind: "key", textHint: "hi" }, // no screenshot
      inlineShot(2, "BBBB"),
      {
        seq: 3,
        tsMs: 0,
        kind: "scroll",
        screenshot: { kind: "file", path: "x.png", width: 1, height: 1, capturedAt: 0 },
      },
    ]
    const resources = buildScreenshotResources(trace(obs))
    expect(resources).toHaveLength(1)
    expect(resources[0].content).toBe("BBBB")
    // Index is sequential over the kept set, not the original seq.
    expect(resources[0].path).toBe("assets/step-01.png")
  })

  it("caps the number of resources", () => {
    const many = Array.from({ length: MAX_SCREENSHOT_RESOURCES + 10 }, (_, i) =>
      inlineShot(i + 1, "X")
    )
    const resources = buildScreenshotResources(trace(many))
    expect(resources).toHaveLength(MAX_SCREENSHOT_RESOURCES)
  })

  it("respects a custom max", () => {
    const many = Array.from({ length: 5 }, (_, i) => inlineShot(i + 1, "X"))
    expect(buildScreenshotResources(trace(many), 2)).toHaveLength(2)
  })
})
