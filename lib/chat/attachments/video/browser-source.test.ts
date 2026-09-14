import { createPixelBuffer } from "@/lib/images/pixel-buffer"
import {
  NATIVE_VIDEO_MEDIA_TYPES,
  openBrowserVideoSource,
  type BrowserSourceDeps,
  type VideoElementLike,
} from "./browser-source"
import { NATIVE_VIDEO_MAX_BYTES } from "./delivery-gate"

interface Script {
  /** What loading the source does. */
  load: "metadata" | "error" | "silent"
  duration?: number
  /** Duration the element settles on after the seek-to-end trick. */
  settledDuration?: number
  width?: number
  height?: number
  /** Seeks never report `seeked`. */
  stuckSeek?: boolean
}

/** A scripted stand-in for `HTMLVideoElement` built on the real `EventTarget`. */
class FakeVideo extends EventTarget implements VideoElementLike {
  muted = false
  preload = ""
  playsInline = false
  readyState = 0
  error: { code: number; message?: string } | null = null
  duration = Number.NaN
  videoWidth = 0
  videoHeight = 0
  seeks: number[] = []
  loadCalls = 0
  paused = false
  removed: string[] = []
  private _src = ""
  private _time = 0

  constructor(private readonly script: Script) {
    super()
  }

  get src() {
    return this._src
  }
  set src(value: string) {
    this._src = value
    setTimeout(() => {
      if (this.script.load === "error") {
        this.error = { code: 4, message: "MEDIA_ERR_SRC_NOT_SUPPORTED" }
        this.dispatchEvent(new Event("error"))
      } else if (this.script.load === "metadata") {
        this.duration = this.script.duration ?? 10
        this.videoWidth = this.script.width ?? 1280
        this.videoHeight = this.script.height ?? 720
        this.readyState = 1
        this.dispatchEvent(new Event("loadedmetadata"))
      }
    }, 0)
  }

  get currentTime() {
    return this._time
  }
  set currentTime(value: number) {
    this.seeks.push(value)
    setTimeout(() => {
      if (!Number.isFinite(this.duration) && this.script.settledDuration !== undefined) {
        this.duration = this.script.settledDuration
        this.dispatchEvent(new Event("durationchange"))
      }
      this._time = Math.min(value, Number.isFinite(this.duration) ? this.duration : value)
      this.readyState = 4
      if (!this.script.stuckSeek) this.dispatchEvent(new Event("seeked"))
    }, 0)
  }

  addEventListener(type: string, listener: () => void) {
    super.addEventListener(type, listener)
  }
  removeEventListener(type: string, listener: () => void) {
    super.removeEventListener(type, listener)
  }
  load() {
    this.loadCalls += 1
  }
  pause() {
    this.paused = true
  }
  removeAttribute(name: string) {
    this.removed.push(name)
  }
}

function deps(video: FakeVideo, overrides: Partial<BrowserSourceDeps> = {}) {
  const revoked: string[] = []
  const value: BrowserSourceDeps = {
    createVideo: () => video,
    createObjectURL: () => "blob:fake-video",
    revokeObjectURL: (url) => revoked.push(url),
    // Encode the element's clock in the red channel so the test can see which
    // frame was drawn.
    drawFrame: (element, width, height) => {
      const buffer = createPixelBuffer(width, height)
      buffer.data[0] = Math.round(element.currentTime * 10)
      return buffer
    },
    timeoutMs: 200,
    ...overrides,
  }
  return { value, revoked }
}

const mp4 = (size = 1024) => new Blob([new Uint8Array(size)], { type: "video/mp4" })

describe("openBrowserVideoSource", () => {
  it("opens the file muted and off-screen and reports its shape", async () => {
    const video = new FakeVideo({ load: "metadata", duration: 42, width: 1920, height: 1080 })
    const { value } = deps(video)
    const source = await openBrowserVideoSource(mp4(), "video/mp4", value)
    expect(video.muted).toBe(true)
    expect(video.playsInline).toBe(true)
    expect(video.src).toBe("blob:fake-video")
    expect(source.engine).toBe("browser")
    expect(source.info).toEqual({
      kind: "video",
      mediaType: "video/mp4",
      durationSec: 42,
      width: 1920,
      height: 1080,
    })
  })

  it("seeks to each time and draws the frame fitted inside the box", async () => {
    const video = new FakeVideo({ load: "metadata", duration: 10, width: 1280, height: 720 })
    const source = await openBrowserVideoSource(mp4(), "video/mp4", deps(video).value)
    const onFrame = jest.fn()
    const frames = await source.grab([1, 4.5, 99], { maxWidth: 320, maxHeight: 320 }, { onFrame })
    expect(frames.map((f) => [f.width, f.height])).toEqual([
      [320, 180],
      [320, 180],
      [320, 180],
    ])
    // A time past the end is clamped just inside it.
    expect(frames.map((f) => f.data[0])).toEqual([10, 45, 100])
    expect(video.seeks[video.seeks.length - 1]).toBeCloseTo(9.999, 3)
    expect(onFrame).toHaveBeenCalledTimes(3)
  })

  it("never upscales a small video", async () => {
    const video = new FakeVideo({ load: "metadata", width: 160, height: 90 })
    const source = await openBrowserVideoSource(mp4(), "video/mp4", deps(video).value)
    const [frame] = await source.grab([1], { maxWidth: 1024, maxHeight: 1024 })
    expect([frame!.width, frame!.height]).toEqual([160, 90])
  })

  it("settles an unknown (Infinity) duration by seeking to the end", async () => {
    const video = new FakeVideo({ load: "metadata", duration: Infinity, settledDuration: 7.5 })
    const source = await openBrowserVideoSource(mp4(), "video/webm", deps(video).value)
    expect(source.info.durationSec).toBe(7.5)
  })

  it.each([
    ["the element errors", { load: "error" } as Script, /cannot decode/],
    ["metadata never arrives", { load: "silent" } as Script, /timed out/],
    [
      "there is no picture track",
      { load: "metadata", width: 0, height: 0 } as Script,
      /picture track/,
    ],
    ["the duration never settles", { load: "metadata", duration: Infinity } as Script, /duration/],
  ])("reports undecodable and cleans up when %s", async (_label, script, message) => {
    const video = new FakeVideo(script)
    const { value, revoked } = deps(video)
    await expect(openBrowserVideoSource(mp4(), "video/mp4", value)).rejects.toMatchObject({
      reason: "undecodable",
      message: expect.stringMatching(message),
    })
    expect(revoked).toEqual(["blob:fake-video"])
    expect(video.removed).toContain("src")
  })

  it("times out a seek that never completes", async () => {
    const video = new FakeVideo({ load: "metadata", stuckSeek: true })
    const source = await openBrowserVideoSource(mp4(), "video/mp4", deps(video).value)
    await expect(source.grab([3], { maxWidth: 64, maxHeight: 64 })).rejects.toMatchObject({
      reason: "undecodable",
    })
  })

  it("reads the whole file for native delivery, within the format and size rules", async () => {
    const video = new FakeVideo({ load: "metadata" })
    const source = await openBrowserVideoSource(mp4(2048), "video/mp4", deps(video).value)
    const native = await source.readNative(null)
    expect(native.mediaType).toBe("video/mp4")
    expect(native.bytes.byteLength).toBe(2048)
    await expect(source.readNative({ startSec: 1, endSec: 2 })).rejects.toMatchObject({
      reason: "trim-unavailable",
    })
  })

  it("refuses a native container no provider accepts, and an oversized file", async () => {
    const mkv = await openBrowserVideoSource(
      new Blob([new Uint8Array(8)]),
      "video/x-matroska",
      deps(new FakeVideo({ load: "metadata" })).value
    )
    expect(NATIVE_VIDEO_MEDIA_TYPES.has("video/x-matroska")).toBe(false)
    await expect(mkv.readNative(null)).rejects.toMatchObject({ reason: "format" })

    const huge = { size: NATIVE_VIDEO_MAX_BYTES + 1, type: "video/mp4" } as Blob
    const big = await openBrowserVideoSource(
      huge,
      "video/mp4",
      deps(new FakeVideo({ load: "metadata" })).value
    )
    await expect(big.readNative(null)).rejects.toMatchObject({ reason: "too-large" })
  })

  it("releases the element and its URL on close, once", async () => {
    const video = new FakeVideo({ load: "metadata" })
    const { value, revoked } = deps(video)
    const source = await openBrowserVideoSource(mp4(), "video/mp4", value)
    await source.close()
    await source.close()
    expect(video.paused).toBe(true)
    expect(video.loadCalls).toBe(1)
    expect(revoked).toEqual(["blob:fake-video"])
  })
})
