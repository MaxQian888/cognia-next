import { createPixelBuffer, type PixelBuffer } from "@/lib/images/pixel-buffer"
import {
  SIGNATURE_GRAB_BOX,
  VideoPreprocessError,
  sampleFrames,
  throwIfAborted,
  type FrameBox,
  type MotionFrameSource,
} from "./frame-source"
import { DEFAULT_VIDEO_SETTINGS } from "./settings"
import { SCENE_CUT_THRESHOLD } from "./timeline"

function solid(width: number, height: number, value: number): PixelBuffer {
  const buffer = createPixelBuffer(width, height)
  for (let i = 0; i < buffer.data.length; i += 4) buffer.data.set([value, value, value, 255], i)
  return buffer
}

/** A 20 s clip whose brightness jumps at 5 s and 12 s. */
function fakeSource(overrides: Partial<MotionFrameSource> = {}) {
  const calls: Array<{ times: number[]; box: FrameBox }> = []
  const brightness = (t: number) => (t < 5 ? 20 : t < 12 ? 20 + SCENE_CUT_THRESHOLD * 8 : 240)
  const source: MotionFrameSource = {
    engine: "browser",
    info: { kind: "video", mediaType: "video/mp4", durationSec: 20, width: 640, height: 360 },
    grab: jest.fn(async (times: readonly number[], box: FrameBox) => {
      calls.push({ times: [...times], box })
      return times.map((t) => solid(Math.min(box.maxWidth, 64), 36, brightness(t)))
    }),
    readNative: jest.fn(),
    close: jest.fn(async () => {}),
    ...overrides,
  }
  return { source, calls }
}

describe("sampleFrames", () => {
  it("grabs evenly spaced frames once for the uniform strategy", async () => {
    const { source, calls } = fakeSource()
    const frames = await sampleFrames(source, DEFAULT_VIDEO_SETTINGS, 4, {
      maxWidth: 320,
      maxHeight: 180,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.times).toEqual([2.5, 7.5, 12.5, 17.5])
    expect(frames.map((f) => f.reason)).toEqual(["uniform", "uniform", "uniform", "uniform"])
  })

  it("honours a trimmed range", async () => {
    const { source, calls } = fakeSource()
    await sampleFrames(
      source,
      { ...DEFAULT_VIDEO_SETTINGS, range: { startSec: 10, endSec: 14 } },
      2,
      { maxWidth: 320, maxHeight: 180 }
    )
    expect(calls[0]!.times).toEqual([11, 13])
  })

  it("scans thumbnails, then grabs only the scene picks at full size", async () => {
    const { source, calls } = fakeSource()
    const frames = await sampleFrames(source, { ...DEFAULT_VIDEO_SETTINGS, strategy: "scene" }, 3, {
      maxWidth: 320,
      maxHeight: 180,
    })
    expect(calls).toHaveLength(2)
    expect(calls[0]!.box).toEqual(SIGNATURE_GRAB_BOX)
    expect(calls[0]!.times).toHaveLength(16)
    expect(calls[1]!.box).toEqual({ maxWidth: 320, maxHeight: 180 })
    expect(frames).toHaveLength(3)
    expect(frames[0]!.reason).toBe("start")
    // Both cuts are found, each at the first candidate past the change.
    const sceneTimes = frames.filter((f) => f.reason === "scene").map((f) => f.timeSec)
    expect(sceneTimes).toHaveLength(2)
    expect(sceneTimes[0]).toBeGreaterThanOrEqual(5)
    expect(sceneTimes[0]).toBeLessThan(6.5)
    expect(sceneTimes[1]).toBeGreaterThanOrEqual(12)
    expect(sceneTimes[1]).toBeLessThan(13.5)
  })

  it("drops picks that land on a frame already taken", async () => {
    const { source } = fakeSource({ frameKeyAt: (t) => Math.floor(t / 10) })
    const frames = await sampleFrames(source, DEFAULT_VIDEO_SETTINGS, 4, {
      maxWidth: 64,
      maxHeight: 64,
    })
    // Times 2.5 / 7.5 share key 0, 12.5 / 17.5 share key 1.
    expect(frames.map((f) => f.timeSec)).toEqual([2.5, 12.5])
  })

  it("stops between grabs once aborted", async () => {
    const controller = new AbortController()
    const { source } = fakeSource({
      grab: jest.fn(async (times: readonly number[]) => {
        controller.abort()
        return times.map(() => solid(8, 8, 0))
      }),
    })
    await expect(
      sampleFrames(
        source,
        { ...DEFAULT_VIDEO_SETTINGS, strategy: "scene" },
        3,
        SIGNATURE_GRAB_BOX,
        {
          signal: controller.signal,
        }
      )
    ).rejects.toMatchObject({ reason: "aborted" })
  })
})

describe("throwIfAborted", () => {
  it("throws an aborted VideoPreprocessError only when the signal fired", () => {
    expect(() => throwIfAborted(undefined)).not.toThrow()
    const controller = new AbortController()
    expect(() => throwIfAborted(controller.signal)).not.toThrow()
    controller.abort()
    expect(() => throwIfAborted(controller.signal)).toThrow(VideoPreprocessError)
  })
})
