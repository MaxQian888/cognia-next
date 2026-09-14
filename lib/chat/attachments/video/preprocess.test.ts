jest.mock("@/lib/tauri", () => ({ transport: { call: jest.fn() } }))
jest.mock("@/lib/media/transport", () => ({ callMediaBinary: jest.fn() }))

import { createPixelBuffer, type PixelBuffer } from "@/lib/images/pixel-buffer"
import { COMPOSER_MAX_ATTACHMENT_BYTES, COMPOSER_VIDEO_SOURCE_MAX_BYTES } from "../prepare"
import {
  NativeVideoPrepareError,
  VideoPreprocessError,
  type FrameBox,
  type MotionFrameSource,
} from "./frame-source"
import {
  FRAME_MAX_LONG_EDGE,
  POSTER_MAX_LONG_EDGE,
  VIDEO_JPEG_QUALITY,
  VIDEO_JPEG_RETRY_QUALITY,
  defaultPreprocessDeps,
  preprocessMotionAttachment,
  type PreprocessDeps,
} from "./preprocess"
import { DEFAULT_VIDEO_SETTINGS, type VideoPreprocessSettings } from "./settings"
import { storyboardLayout } from "./storyboard"

function solid(width: number, height: number, value: number): PixelBuffer {
  const buffer = createPixelBuffer(width, height)
  for (let i = 0; i < buffer.data.length; i += 4) buffer.data.set([value, value, value, 255], i)
  return buffer
}

function fakeSource(
  engine: MotionFrameSource["engine"],
  overrides: Partial<MotionFrameSource> = {}
): MotionFrameSource & { closed: jest.Mock } {
  const closed = jest.fn(async () => {})
  return {
    engine,
    info: {
      kind: engine === "gif" ? "gif" : "video",
      mediaType: engine === "gif" ? "image/gif" : "video/mp4",
      durationSec: 30,
      width: 1920,
      height: 1080,
      ...(engine === "gif" ? { frameCount: 40 } : {}),
    },
    grab: jest.fn(
      async (times: readonly number[], box: FrameBox, options?: { onFrame?: () => void }) =>
        times.map((t) => {
          options?.onFrame?.()
          const scale = Math.min(1, box.maxWidth / 1920, box.maxHeight / 1080)
          return solid(Math.round(1920 * scale), Math.round(1080 * scale), Math.round(t * 8))
        })
    ),
    readNative: jest.fn(async () => ({ bytes: new Uint8Array(2048), mediaType: "video/mp4" })),
    close: closed,
    closed,
    ...overrides,
  }
}

function makeDeps(overrides: Partial<PreprocessDeps> = {}) {
  const deps: PreprocessDeps = {
    openGif: jest.fn(async () => null),
    openBrowser: jest.fn(async () => fakeSource("browser")),
    openFfmpeg: jest.fn(async () => fakeSource("ffmpeg")),
    canUseFfmpeg: jest.fn(() => false),
    // A tenth of a byte per pixel: big enough to exercise the ceiling logic.
    encodeJpeg: jest.fn(async (buffer: PixelBuffer) => ({
      bytes: new Uint8Array(Math.ceil((buffer.width * buffer.height) / 10)),
      mediaType: "image/jpeg",
    })),
    ...overrides,
  }
  return deps
}

const video = (size = 4096) => new Blob([new Uint8Array(size)], { type: "video/mp4" })
const request = (settings: Partial<VideoPreprocessSettings> = {}, blob = video()) => ({
  blob,
  filename: "demo.mp4",
  mediaType: "video/mp4",
  settings: { ...DEFAULT_VIDEO_SETTINGS, ...settings },
})

async function run(settings: Partial<VideoPreprocessSettings> = {}, deps = makeDeps()) {
  const outcome = await preprocessMotionAttachment(request(settings), deps)
  if (outcome.kind !== "motion") throw new Error("expected a motion result")
  return outcome.result
}

describe("preprocessMotionAttachment — defaults", () => {
  it("turns an untouched video into one 3×3 storyboard image plus its description", async () => {
    const deps = makeDeps()
    const result = await run({}, deps)
    expect(result.engine).toBe("browser")
    expect(result.sampled.delivery).toBe("storyboard")
    expect(result.sampled.grid).toEqual({ columns: 3, rows: 3 })
    expect(result.sampled.frames).toHaveLength(9)
    expect(result.sampled.images).toHaveLength(1)
    expect(result.sampled.blocks.map((b) => b.type)).toEqual(["text", "image"])
    const text = result.sampled.blocks[0] as { text: string }
    expect(text.text).toContain('Attached video "demo.mp4"')
    expect(text.text).toBe(result.sampled.description)
    expect(result.sampled.estimatedImageTokens).toBeGreaterThan(0)
    expect(result.native).toBeNull()
    expect(result.nativeFailure).toBeNull()
    expect(deps.encodeJpeg).toHaveBeenCalledWith(expect.anything(), VIDEO_JPEG_QUALITY)
  })

  it("makes a poster from the first frame, no larger than the poster edge", async () => {
    const result = await run()
    expect(Math.max(result.poster.width, result.poster.height)).toBeLessThanOrEqual(
      POSTER_MAX_LONG_EDGE
    )
    expect(result.poster.mediaType).toBe("image/jpeg")
    expect(result.poster.base64.length).toBeGreaterThan(0)
  })

  it("always closes the source", async () => {
    const source = fakeSource("browser")
    await run({}, makeDeps({ openBrowser: jest.fn(async () => source) }))
    expect(source.closed).toHaveBeenCalledTimes(1)

    const failing = fakeSource("browser", {
      grab: jest.fn(async () => {
        throw new VideoPreprocessError("undecodable", "seek failed")
      }),
    })
    await expect(
      run({}, makeDeps({ openBrowser: jest.fn(async () => failing) }))
    ).rejects.toMatchObject({
      reason: "undecodable",
    })
    expect(failing.closed).toHaveBeenCalledTimes(1)
  })
})

describe("preprocessMotionAttachment — settings", () => {
  it("sends separate frames at the frame edge, each an image block after the text", async () => {
    const deps = makeDeps()
    const result = await run({ delivery: "frames", frameCount: 4 }, deps)
    expect(result.sampled.images).toHaveLength(4)
    expect(result.sampled.grid).toBeUndefined()
    expect(result.sampled.blocks.map((b) => b.type)).toEqual([
      "text",
      "image",
      "image",
      "image",
      "image",
    ])
    expect(Math.max(result.sampled.images[0]!.width, result.sampled.images[0]!.height)).toBe(
      FRAME_MAX_LONG_EDGE
    )
  })

  it("normalises settings against the clip before using them", async () => {
    const result = await run({ frameCount: 99, range: { startSec: 10, endSec: 500 } })
    expect(result.settings.frameCount).toBe(16)
    expect(result.settings.range).toEqual({ startSec: 10, endSec: 30 })
    expect(result.sampled.frames.every((f) => f.timeSec >= 10 && f.timeSec <= 30)).toBe(true)
    // A 30 s clip is labelled in tenths.
    expect(result.sampled.description).toContain("trimmed range 0:10.0–0:30.0")
  })

  it("reports progress up to completion", async () => {
    const seen: number[] = []
    await preprocessMotionAttachment(
      { ...request({ strategy: "scene" }), onProgress: (fraction) => seen.push(fraction) },
      makeDeps()
    )
    expect(seen.length).toBeGreaterThan(3)
    expect(seen[seen.length - 1]).toBe(1)
    expect(seen.every((value, i) => i === 0 || value >= seen[i - 1]!)).toBe(true)
  })
})

describe("preprocessMotionAttachment — engines", () => {
  it("falls back to ffmpeg when the webview cannot decode and ffmpeg is local", async () => {
    const deps = makeDeps({
      openBrowser: jest.fn(async () => {
        throw new VideoPreprocessError("undecodable", "HEVC not supported")
      }),
      canUseFfmpeg: jest.fn(() => true),
    })
    const result = await run({}, deps)
    expect(result.engine).toBe("ffmpeg")
    expect(result.browserFailure).toBe("HEVC not supported")
    expect(deps.openFfmpeg).toHaveBeenCalledWith(expect.any(Blob), "video/mp4", "demo.mp4")
  })

  it("says the fallback is not available here when ffmpeg is not local", async () => {
    const deps = makeDeps({
      openBrowser: jest.fn(async () => {
        throw new VideoPreprocessError("undecodable", "no codec")
      }),
    })
    await expect(run({}, deps)).rejects.toMatchObject({
      reason: "undecodable",
      ffmpeg: "not-available-here",
    })
    expect(deps.openFfmpeg).not.toHaveBeenCalled()
  })

  it("does not hide a non-format browser failure behind ffmpeg", async () => {
    const deps = makeDeps({
      openBrowser: jest.fn(async () => {
        throw new VideoPreprocessError("failed", "no canvas")
      }),
      canUseFfmpeg: jest.fn(() => true),
    })
    await expect(run({}, deps)).rejects.toMatchObject({ reason: "failed" })
    expect(deps.openFfmpeg).not.toHaveBeenCalled()
  })

  it("routes a GIF to the GIF engine and lets a still GIF leave the pipeline", async () => {
    const gifRequest = { ...request(), filename: "loop.gif", mediaType: "image/gif" }
    const still = await preprocessMotionAttachment(gifRequest, makeDeps())
    expect(still).toEqual({ kind: "still-gif" })

    const deps = makeDeps({ openGif: jest.fn(async () => fakeSource("gif")) })
    const animated = await preprocessMotionAttachment(gifRequest, deps)
    expect(animated.kind).toBe("motion")
    expect(deps.openBrowser).not.toHaveBeenCalled()
  })

  it("rebuilds the storyboard grid when a short GIF has fewer distinct frames", async () => {
    const gif = fakeSource("gif", { frameKeyAt: (t) => Math.floor(t / 10) })
    const outcome = await preprocessMotionAttachment(
      { ...request(), filename: "loop.gif", mediaType: "image/gif" },
      makeDeps({ openGif: jest.fn(async () => gif) })
    )
    if (outcome.kind !== "motion") throw new Error("expected motion")
    expect(outcome.result.sampled.frames).toHaveLength(3)
    // Laid out for the 3 frames that exist, not the 9 asked for.
    const three = storyboardLayout(3, 1920, 1080)
    expect(outcome.result.sampled.grid).toEqual({ columns: three.columns, rows: three.rows })
    expect(three.columns * three.rows).toBeLessThan(9)
  })

  it("refuses a source over the local ceiling before opening anything", async () => {
    const deps = makeDeps()
    const huge = { size: COMPOSER_VIDEO_SOURCE_MAX_BYTES + 1, type: "video/mp4" } as Blob
    await expect(preprocessMotionAttachment(request({}, huge), deps)).rejects.toMatchObject({
      reason: "too-large",
    })
    expect(deps.openBrowser).not.toHaveBeenCalled()
  })
})

describe("preprocessMotionAttachment — output ceiling", () => {
  it("re-encodes at a lower quality, then refuses", async () => {
    const perImage = COMPOSER_MAX_ATTACHMENT_BYTES / 2
    const retried = makeDeps({
      encodeJpeg: jest.fn(async (_buffer: PixelBuffer, quality: number) => ({
        bytes: new Uint8Array(quality === VIDEO_JPEG_QUALITY ? perImage : 16),
        mediaType: "image/jpeg",
      })),
    })
    const result = await run({ delivery: "frames", frameCount: 3 }, retried)
    expect(result.sampled.images.every((image) => image.bytes === 16)).toBe(true)
    expect(retried.encodeJpeg).toHaveBeenCalledWith(expect.anything(), VIDEO_JPEG_RETRY_QUALITY)

    const hopeless = makeDeps({
      encodeJpeg: jest.fn(async () => ({
        bytes: new Uint8Array(perImage),
        mediaType: "image/jpeg",
      })),
    })
    await expect(run({ delivery: "frames", frameCount: 3 }, hopeless)).rejects.toMatchObject({
      reason: "too-large",
    })
  })
})

describe("preprocessMotionAttachment — native", () => {
  it("prepares the file and still builds the storyboard fallback", async () => {
    const result = await run({ delivery: "native", frameCount: 2 })
    expect(result.native).not.toBeNull()
    expect(result.native!.blocks.map((b) => b.type)).toEqual(["text", "document"])
    expect(result.native!.description).toContain("Sent as the original video file.")
    const document = result.native!.blocks[1] as { source: { media_type: string; data: string } }
    expect(document.source.media_type).toBe("video/mp4")
    expect(result.native!.bytes).toBe(2048)
    // The fallback is a storyboard, with the count raised into storyboard bounds.
    expect(result.sampled.delivery).toBe("storyboard")
    expect(result.sampled.frames).toHaveLength(4)
    expect(result.nativeTrimSupported).toBe(false)
  })

  it("cuts a trimmed clip with ffmpeg when the webview opened the file", async () => {
    const cutter = fakeSource("ffmpeg")
    const deps = makeDeps({
      canUseFfmpeg: jest.fn(() => true),
      openFfmpeg: jest.fn(async () => cutter),
    })
    const result = await run({ delivery: "native", range: { startSec: 5, endSec: 9 } }, deps)
    expect(cutter.readNative).toHaveBeenCalledWith({ startSec: 5, endSec: 9 }, undefined)
    expect(cutter.closed).toHaveBeenCalled()
    expect(result.native!.description).toContain("trimmed to 0:05.0–0:09.0")
    expect(result.nativeTrimSupported).toBe(true)
  })

  it("reports trim-unavailable without ffmpeg, keeping the sampled result", async () => {
    const result = await run({ delivery: "native", range: { startSec: 5, endSec: 9 } })
    expect(result.native).toBeNull()
    expect(result.nativeFailure).toBe("trim-unavailable")
    expect(result.sampled.images).toHaveLength(1)
  })

  it("carries the engine's own refusal reason", async () => {
    const deps = makeDeps({
      openBrowser: jest.fn(async () =>
        fakeSource("browser", {
          readNative: jest.fn(async () => {
            throw new NativeVideoPrepareError("too-large", "big")
          }),
        })
      ),
    })
    expect((await run({ delivery: "native" }, deps)).nativeFailure).toBe("too-large")
  })

  it("maps a missing ffmpeg during the cut to ffmpeg-missing", async () => {
    const deps = makeDeps({
      canUseFfmpeg: jest.fn(() => true),
      openFfmpeg: jest.fn(async () => {
        throw new VideoPreprocessError("undecodable", "no ffmpeg", "missing")
      }),
    })
    const result = await run({ delivery: "native", range: { startSec: 1, endSec: 3 } }, deps)
    expect(result.nativeFailure).toBe("ffmpeg-missing")
  })

  it("never offers a native trim for a GIF", async () => {
    const outcome = await preprocessMotionAttachment(
      { ...request({ delivery: "native" }), filename: "a.gif", mediaType: "image/gif" },
      makeDeps({
        canUseFfmpeg: jest.fn(() => true),
        openGif: jest.fn(async () =>
          fakeSource("gif", {
            readNative: jest.fn(async () => {
              throw new NativeVideoPrepareError("format", "gif")
            }),
          })
        ),
      })
    )
    if (outcome.kind !== "motion") throw new Error("expected motion")
    expect(outcome.result.nativeTrimSupported).toBe(false)
    expect(outcome.result.nativeFailure).toBe("format")
  })
})

describe("preprocessMotionAttachment — cancellation", () => {
  it("rejects as aborted and does not swallow it as a native failure", async () => {
    const controller = new AbortController()
    const deps = makeDeps({
      openBrowser: jest.fn(async () =>
        fakeSource("browser", {
          readNative: jest.fn(async () => {
            controller.abort()
            throw new VideoPreprocessError("aborted", "cancelled")
          }),
        })
      ),
    })
    await expect(
      preprocessMotionAttachment(
        { ...request({ delivery: "native" }), signal: controller.signal },
        deps
      )
    ).rejects.toMatchObject({ reason: "aborted" })
  })

  it("does nothing for an already-cancelled run", async () => {
    const controller = new AbortController()
    controller.abort()
    const deps = makeDeps()
    await expect(
      preprocessMotionAttachment({ ...request(), signal: controller.signal }, deps)
    ).rejects.toMatchObject({ reason: "aborted" })
    expect(deps.openBrowser).not.toHaveBeenCalled()
  })
})

describe("defaultPreprocessDeps", () => {
  it("binds every engine and the local ffmpeg predicate", () => {
    expect(Object.keys(defaultPreprocessDeps).sort()).toEqual(
      ["canUseFfmpeg", "encodeJpeg", "openBrowser", "openFfmpeg", "openGif"].sort()
    )
    // Node is not a desktop host.
    expect(defaultPreprocessDeps.canUseFfmpeg()).toBe(false)
  })

  it("encodes through the image engine, flattened to an opaque JPEG", async () => {
    // No canvas in the node project: the image engine reports that honestly.
    await expect(defaultPreprocessDeps.encodeJpeg(solid(2, 2, 0), 0.8)).rejects.toThrow(/canvas/)
  })
})
