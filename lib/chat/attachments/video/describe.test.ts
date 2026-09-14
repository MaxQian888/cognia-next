import { describeVideoForModel, type VideoDescriptionInput } from "./describe"

const video: VideoDescriptionInput = {
  filename: "demo.mp4",
  source: { kind: "video", mediaType: "video/mp4", durationSec: 90, width: 1920, height: 1080 },
  delivery: "storyboard",
  strategy: "uniform",
  range: { startSec: 0, endSec: 90 },
  trimmed: false,
  frames: [5, 15, 25, 35, 45, 55, 65, 75, 85].map((timeSec) => ({ timeSec, reason: "uniform" })),
  grid: { columns: 3, rows: 3 },
}

describe("describeVideoForModel", () => {
  it("describes a storyboard: source shape, grid, order and every timestamp", () => {
    expect(describeVideoForModel(video)).toBe(
      [
        'Attached video "demo.mp4" (1:30, 1920×1080).',
        "Storyboard: one image with 9 frames sampled evenly from 0:00–1:30, laid out as a 3×3 grid in reading order (left to right, top to bottom). Each frame is labelled with its timestamp.",
        "Frame times: 0:05, 0:15, 0:25, 0:35, 0:45, 0:55, 1:05, 1:15, 1:25.",
      ].join("\n")
    )
  })

  it("describes separate frames and a trim", () => {
    const text = describeVideoForModel({
      ...video,
      delivery: "frames",
      range: { startSec: 30, endSec: 60 },
      trimmed: true,
      frames: [
        { timeSec: 35, reason: "uniform" },
        { timeSec: 55, reason: "uniform" },
      ],
      grid: undefined,
    })
    expect(text).toContain(
      "Frames: the next 2 images, in order, sampled evenly from the trimmed range 0:30–1:00."
    )
    expect(text).toContain("Frame times: 0:35, 0:55.")
  })

  it("is honest about scene detection that found cuts only for some frames", () => {
    const text = describeVideoForModel({
      ...video,
      strategy: "scene",
      frames: [
        { timeSec: 0, reason: "start" },
        { timeSec: 12, reason: "scene" },
        { timeSec: 50, reason: "uniform" },
      ],
    })
    expect(text).toContain(
      "at scene changes in 0:00–1:30, evenly spaced where there was no clear cut"
    )
  })

  it("says so when scene detection found no cuts at all", () => {
    const text = describeVideoForModel({
      ...video,
      strategy: "scene",
      frames: [
        { timeSec: 0, reason: "start" },
        { timeSec: 45, reason: "uniform" },
      ],
    })
    expect(text).toContain("evenly from 0:00–1:30 (no clear scene changes were found)")
  })

  it("uses tenths for a short GIF and names its frame count", () => {
    const text = describeVideoForModel({
      ...video,
      filename: "loop.gif",
      source: {
        kind: "gif",
        mediaType: "image/gif",
        durationSec: 2.4,
        width: 320,
        height: 240,
        frameCount: 24,
      },
      range: { startSec: 0, endSec: 2.4 },
      frames: [
        { timeSec: 0.2, reason: "uniform" },
        { timeSec: 1.4, reason: "uniform" },
      ],
      grid: { columns: 2, rows: 1 },
    })
    expect(text.split("\n")[0]).toBe('Attached animated GIF "loop.gif" (2.4s, 24 frames, 320×240).')
    expect(text).toContain("Frame times: 0:00.2, 0:01.4.")
  })

  it("describes a native video, with and without a trim", () => {
    expect(describeVideoForModel({ ...video, delivery: "native", frames: [] })).toBe(
      'Attached video "demo.mp4" (1:30, 1920×1080).\nSent as the original video file.'
    )
    expect(
      describeVideoForModel({
        ...video,
        delivery: "native",
        frames: [],
        trimmed: true,
        range: { startSec: 10, endSec: 20 },
      })
    ).toContain("trimmed to 0:10–0:20.")
  })

  it("omits a size it does not know", () => {
    const text = describeVideoForModel({
      ...video,
      source: { ...video.source, width: 0, height: 0 },
    })
    expect(text.split("\n")[0]).toBe('Attached video "demo.mp4" (1:30).')
  })
})
