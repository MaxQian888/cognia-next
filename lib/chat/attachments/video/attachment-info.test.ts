import {
  VIDEO_ATTACHMENT_PART_KEY,
  readVideoAttachmentInfo,
  videoAttachmentInfoOfPart,
  type VideoAttachmentInfo,
} from "./attachment-info"

const info: VideoAttachmentInfo = {
  groupId: "att-1",
  filename: "demo.mp4",
  sourceMediaType: "video/mp4",
  kind: "video",
  durationSec: 42,
  width: 1920,
  height: 1080,
  delivery: "storyboard",
  strategy: "scene",
  range: { startSec: 2, endSec: 30 },
  frameTimes: [2, 8.5, 20],
  grid: { columns: 2, rows: 2 },
  engine: "browser",
}

describe("readVideoAttachmentInfo", () => {
  it("round-trips what the adapter writes, through JSON", () => {
    expect(readVideoAttachmentInfo(JSON.parse(JSON.stringify(info)))).toEqual(info)
  })

  it("keeps optional fields optional", () => {
    const minimal = { ...info, range: null, grid: undefined, frameCount: undefined }
    const parsed = readVideoAttachmentInfo(minimal)!
    expect(parsed.range).toBeNull()
    expect("grid" in parsed).toBe(false)
    expect("frameCount" in parsed).toBe(false)
    expect(readVideoAttachmentInfo({ ...info, kind: "gif", frameCount: 24 })?.frameCount).toBe(24)
  })

  it.each([
    ["no group id", { groupId: "" }],
    ["an unknown kind", { kind: "audio" }],
    ["an unknown delivery", { delivery: "gif" }],
    ["an unknown strategy", { strategy: "keyframes" }],
    ["an unknown engine", { engine: "wasm" }],
    ["a non-numeric duration", { durationSec: "42" }],
    ["frame times that are not numbers", { frameTimes: [1, "2"] }],
    ["a half range", { range: { startSec: 1 } }],
    ["a broken grid", { grid: { columns: 2 } }],
  ])("rejects %s", (_label, override) => {
    expect(readVideoAttachmentInfo({ ...info, ...override })).toBeNull()
  })

  it("rejects non-objects", () => {
    expect(readVideoAttachmentInfo(null)).toBeNull()
    expect(readVideoAttachmentInfo("video")).toBeNull()
  })
})

describe("videoAttachmentInfoOfPart", () => {
  it("reads the descriptor under the shared key", () => {
    expect(
      videoAttachmentInfoOfPart({
        type: "file",
        url: "cognia-media:x",
        [VIDEO_ATTACHMENT_PART_KEY]: info,
      })
    ).toEqual(info)
    expect(videoAttachmentInfoOfPart({ type: "file", url: "cognia-media:x" })).toBeNull()
    expect(videoAttachmentInfoOfPart(undefined)).toBeNull()
  })
})
