jest.mock("@/lib/tauri", () => ({ transport: { call: jest.fn() } }))
jest.mock("@/lib/media/transport", () => ({ callMediaBinary: jest.fn() }))
jest.mock("@/lib/platform/capabilities", () => ({ detectHostProfile: jest.fn(() => "desktop") }))
jest.mock("@/lib/tauri/transport-routing", () => ({ getActiveRemoteEndpoint: jest.fn(() => null) }))
jest.mock("@tauri-apps/plugin-fs", () => ({
  BaseDirectory: { AppData: 14 },
  mkdir: jest.fn(async () => {}),
  remove: jest.fn(async () => {}),
  writeFile: jest.fn(async () => {}),
}))
jest.mock("@tauri-apps/api/path", () => ({
  appDataDir: jest.fn(async () => "/Users/me/Library/Application Support/cognia"),
  join: jest.fn(async (...parts: string[]) => parts.join("/")),
}))

import * as fs from "@tauri-apps/plugin-fs"

import { transport } from "@/lib/tauri"
import { callMediaBinary } from "@/lib/media/transport"
import { detectHostProfile } from "@/lib/platform/capabilities"
import { getActiveRemoteEndpoint } from "@/lib/tauri/transport-routing"
import {
  FFMPEG_STAGING_CHUNK_BYTES,
  FFMPEG_STAGING_DIR,
  canUseLocalFfmpeg,
  defaultFfmpegSourceDeps,
  isMissingFfmpegError,
  openFfmpegVideoSource,
  type FfmpegSourceDeps,
} from "./ffmpeg-source"
import { NATIVE_VIDEO_MAX_BYTES } from "./delivery-gate"

const detectHostProfileMock = detectHostProfile as jest.Mock
const getActiveRemoteEndpointMock = getActiveRemoteEndpoint as jest.Mock

function packedFrame(width: number, height: number, value: number): Uint8Array {
  const out = new Uint8Array(8 + width * height * 4).fill(value)
  const view = new DataView(out.buffer)
  view.setUint32(0, width, true)
  view.setUint32(4, height, true)
  return out
}

const info = {
  durationMs: 12_000,
  width: 1920,
  height: 1080,
  fps: 59.94,
  codec: "hevc",
  fileSize: 1024,
  hasAudio: true,
  sourceToken: "token-1",
}

function makeDeps(overrides: Partial<FfmpegSourceDeps> = {}) {
  const remove = jest.fn(async () => {})
  const deps: FfmpegSourceDeps = {
    stageFile: jest.fn(async () => ({ path: "/app-data/composer-video-staging/x.mkv", remove })),
    call: jest.fn(async () => info) as FfmpegSourceDeps["call"],
    callBinary: jest.fn(async (command: string) =>
      command === "plugin_media_get_video_frame" ? packedFrame(64, 36, 9) : new Uint8Array(4096)
    ) as FfmpegSourceDeps["callBinary"],
    ...overrides,
  }
  return { deps, remove }
}

const blob = (size = 64, type = "video/x-matroska") => new Blob([new Uint8Array(size)], { type })

describe("canUseLocalFfmpeg", () => {
  afterEach(() => {
    detectHostProfileMock.mockReturnValue("desktop")
    getActiveRemoteEndpointMock.mockReturnValue(null)
  })

  it("is true only on a desktop host that is not driving a remote one", () => {
    expect(canUseLocalFfmpeg()).toBe(true)
    getActiveRemoteEndpointMock.mockReturnValue({ url: "https://host" })
    expect(canUseLocalFfmpeg()).toBe(false)
    getActiveRemoteEndpointMock.mockReturnValue(null)
    for (const profile of ["mobile-companion", "cloud-companion", "web-standalone", "headless"]) {
      detectHostProfileMock.mockReturnValue(profile)
      expect(canUseLocalFfmpeg()).toBe(false)
    }
  })
})

describe("isMissingFfmpegError", () => {
  it("recognises the serde-tagged error and its Display text, nothing else", () => {
    expect(isMissingFfmpegError({ code: "MISSING_DEPENDENCY", binary: "ffprobe" })).toBe(true)
    expect(
      isMissingFfmpegError(new Error("Required media tool 'ffmpeg' was not found on PATH"))
    ).toBe(true)
    expect(isMissingFfmpegError({ code: "PROCESS_FAILED", binary: "ffprobe", message: "x" })).toBe(
      false
    )
    expect(isMissingFfmpegError(new Error("ffprobe failed: invalid data"))).toBe(false)
    expect(isMissingFfmpegError(undefined)).toBe(false)
  })
})

describe("defaultFfmpegSourceDeps.stageFile", () => {
  const writeFileMock = fs.writeFile as jest.Mock
  const removeMock = fs.remove as jest.Mock
  beforeEach(() => {
    writeFileMock.mockReset().mockResolvedValue(undefined)
    removeMock.mockReset().mockResolvedValue(undefined)
  })

  it("copies the blob into AppData in appended chunks and returns an absolute path", async () => {
    const size = FFMPEG_STAGING_CHUNK_BYTES * 2 + 5
    const staged = await defaultFfmpegSourceDeps.stageFile(new Blob([new Uint8Array(size)]), "MOV")
    expect(fs.mkdir).toHaveBeenCalledWith(FFMPEG_STAGING_DIR, { baseDir: 14, recursive: true })
    expect(writeFileMock.mock.calls.map((call) => [call[1].byteLength, call[2].append])).toEqual([
      [FFMPEG_STAGING_CHUNK_BYTES, false],
      [FFMPEG_STAGING_CHUNK_BYTES, true],
      [5, true],
    ])
    const relative = writeFileMock.mock.calls[0][0] as string
    expect(relative).toMatch(new RegExp(`^${FFMPEG_STAGING_DIR}/.+\\.mov$`))
    expect(staged.path).toBe(`/Users/me/Library/Application Support/cognia/${relative}`)
    await staged.remove()
    expect(removeMock).toHaveBeenCalledWith(relative, { baseDir: 14 })
  })

  it("never lets an extension escape the staging directory", async () => {
    await defaultFfmpegSourceDeps.stageFile(new Blob([new Uint8Array(1)]), "../../evil")
    expect(writeFileMock.mock.calls[0][0]).toMatch(/\.bin$/)
  })

  it("removes a partial copy when a write fails", async () => {
    writeFileMock.mockRejectedValueOnce(new Error("quota"))
    await expect(
      defaultFfmpegSourceDeps.stageFile(new Blob([new Uint8Array(3)]), "mp4")
    ).rejects.toThrow("quota")
    expect(removeMock).toHaveBeenCalledTimes(1)
  })
})

describe("defaultFfmpegSourceDeps", () => {
  it("routes commands through the shared transport and binary reader", async () => {
    ;(transport.call as jest.Mock).mockResolvedValueOnce("ok")
    await expect(defaultFfmpegSourceDeps.call("video_get_info", { filePath: "/x" })).resolves.toBe(
      "ok"
    )
    expect(transport.call).toHaveBeenCalledWith("video_get_info", { filePath: "/x" })
    ;(callMediaBinary as jest.Mock).mockResolvedValueOnce(new Uint8Array(1))
    const signal = new AbortController().signal
    await defaultFfmpegSourceDeps.callBinary("plugin_media_get_video_frame", { time: 1 }, signal)
    expect(callMediaBinary).toHaveBeenCalledWith(
      "plugin_media_get_video_frame",
      { time: 1 },
      signal
    )
  })
})

describe("openFfmpegVideoSource", () => {
  it("stages the file, probes it and reports its shape", async () => {
    const { deps } = makeDeps()
    const source = await openFfmpegVideoSource(blob(), "video/x-matroska", "clip.MKV", deps)
    expect(deps.stageFile).toHaveBeenCalledWith(expect.any(Blob), "MKV")
    expect(deps.call).toHaveBeenCalledWith("video_get_info", {
      filePath: "/app-data/composer-video-staging/x.mkv",
    })
    expect(source.engine).toBe("ffmpeg")
    expect(source.info).toEqual({
      kind: "video",
      mediaType: "video/x-matroska",
      durationSec: 12,
      width: 1920,
      height: 1080,
    })
  })

  it("grabs frames by token, clamped inside the clip, and fits them", async () => {
    const { deps } = makeDeps()
    const source = await openFfmpegVideoSource(blob(), "video/x-matroska", "a.mkv", deps)
    const frames = await source.grab([-1, 5, 50], { maxWidth: 32, maxHeight: 32 })
    expect((deps.callBinary as jest.Mock).mock.calls.map((call) => call[1])).toEqual([
      { sourceToken: "token-1", time: 0 },
      { sourceToken: "token-1", time: 5 },
      { sourceToken: "token-1", time: 11.95 },
    ])
    expect(frames.map((f) => [f.width, f.height])).toEqual([
      [32, 18],
      [32, 18],
      [32, 18],
    ])
  })

  it("names a missing ffmpeg as such, and removes the staged copy", async () => {
    const { deps, remove } = makeDeps({
      call: jest.fn(async () => {
        throw new Error('{"code":"MISSING_DEPENDENCY","binary":"ffprobe"}')
      }) as FfmpegSourceDeps["call"],
    })
    await expect(openFfmpegVideoSource(blob(), "video/mp4", "a.mp4", deps)).rejects.toMatchObject({
      reason: "undecodable",
      ffmpeg: "missing",
    })
    expect(remove).toHaveBeenCalled()
  })

  it("treats a probe with no picture as undecodable", async () => {
    const { deps, remove } = makeDeps({
      call: jest.fn(async () => ({ ...info, width: 0 })) as FfmpegSourceDeps["call"],
    })
    await expect(openFfmpegVideoSource(blob(), "video/mp4", "a.mp4", deps)).rejects.toMatchObject({
      reason: "undecodable",
      ffmpeg: "failed",
    })
    expect(remove).toHaveBeenCalled()
  })

  it("reports a staging failure as a failed run", async () => {
    const { deps } = makeDeps({
      stageFile: jest.fn(async () => {
        throw new Error("disk full")
      }),
    })
    await expect(openFfmpegVideoSource(blob(), "video/mp4", "a.mp4", deps)).rejects.toMatchObject({
      reason: "failed",
      message: expect.stringContaining("disk full"),
    })
  })

  it("cuts a trimmed native clip with the export command", async () => {
    const { deps } = makeDeps()
    const source = await openFfmpegVideoSource(blob(), "video/x-matroska", "a.mkv", deps)
    const native = await source.readNative({ startSec: 2, endSec: 6 })
    expect(native).toEqual({ bytes: expect.any(Uint8Array), mediaType: "video/mp4" })
    const exportCall = (deps.callBinary as jest.Mock).mock.calls.find(
      (call) => call[0] === "plugin_media_export_video"
    )!
    expect(exportCall[1]).toEqual({
      clips: [
        {
          sourceToken: "token-1",
          startTime: 2,
          endTime: 6,
          volume: 1,
          playbackSpeed: 1,
          effects: [],
          transitionOut: null,
        },
      ],
      options: { format: "mp4", resolution: "720p", fps: 30, quality: "medium" },
    })
  })

  it("refuses an over-ceiling cut and maps a missing ffmpeg", async () => {
    const tooBig = makeDeps({
      callBinary: jest.fn(
        async () => new Uint8Array(NATIVE_VIDEO_MAX_BYTES + 1)
      ) as FfmpegSourceDeps["callBinary"],
    })
    const source = await openFfmpegVideoSource(blob(), "video/mp4", "a.mp4", tooBig.deps)
    await expect(source.readNative({ startSec: 0, endSec: 1 })).rejects.toMatchObject({
      reason: "too-large",
    })

    const missing = makeDeps({
      callBinary: jest.fn(async () => {
        throw new Error("MissingDependency: ffmpeg")
      }) as FfmpegSourceDeps["callBinary"],
    })
    const other = await openFfmpegVideoSource(blob(), "video/mp4", "a.mp4", missing.deps)
    await expect(other.readNative({ startSec: 0, endSec: 1 })).rejects.toMatchObject({
      reason: "ffmpeg-missing",
    })
  })

  it("sends an untrimmed file as-is when its format is accepted", async () => {
    const { deps } = makeDeps()
    const mp4 = await openFfmpegVideoSource(blob(100, "video/mp4"), "video/mp4", "a.mp4", deps)
    await expect(mp4.readNative(null)).resolves.toMatchObject({ mediaType: "video/mp4" })
    const mkv = await openFfmpegVideoSource(blob(), "video/x-matroska", "a.mkv", deps)
    await expect(mkv.readNative(null)).rejects.toMatchObject({ reason: "format" })
  })

  it("removes the staged copy on close", async () => {
    const { deps, remove } = makeDeps()
    const source = await openFfmpegVideoSource(blob(), "video/mp4", "a.mp4", deps)
    await source.close()
    expect(remove).toHaveBeenCalledTimes(1)
  })
})
