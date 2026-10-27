import { prepareMediaPackForDesktop, type MediaPrepareDeps } from "./prepare"
import type { MediaPackAsset } from "./manifest"
jest.mock("./manifest", () => ({ ...jest.requireActual("./manifest"), MAX_MEDIA_PACK_BYTES: 64 }))
const localCall = jest.fn()
jest.mock("@/lib/tauri/transport-instance", () => ({
  localTransport: { call: (...args: unknown[]) => localCall(...args) },
}))
jest.mock("@/lib/platform/detect", () => ({ isTauri: () => true }))
jest.mock("@/lib/tauri/account-app-data", () => ({
  PET_MEDIA_STAGING_APP_DATA_DIR: "pet-media-staging",
  activeDatabaseAppDataDir: (dir: string) => `${dir}/acct/database`,
}))
const removeFile = jest.fn(async (_path: string) => {})
jest.mock("@/lib/tauri/app-data-files", () => ({
  writeBlobToAppData: async () => "/local/account/video.webm",
  removeAppDataFile: (path: string) => removeFile(path),
}))
const pack: MediaPackAsset = {
  id: "mp_video",
  manifest: {
    version: 1,
    displayName: "Whale",
    source: "dsh-video",
    width: 640,
    height: 360,
    clips: { idle: { kind: "video", file: "idle.webm", loop: true } },
    states: { idle: ["idle"] },
    ambient: [],
  },
  entries: [{ path: "idle.webm", blob: new Blob(["video"]) }],
  totalBytes: 5,
  createdAt: 0,
}
function sheet() {
  const bytes = new Uint8Array(32)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 4096, true)
  view.setUint32(4, 288, true)
  bytes.set([82, 73, 70, 70], 8)
  bytes.set([87, 69, 66, 80], 16)
  return bytes
}
function deps() {
  const remove = jest.fn(async () => {})
  return {
    stage: jest.fn(async () => ({ path: "/account/staged.webm", remove })),
    probe: jest.fn(async () => ({ durationMs: 1000, sourceToken: "authorized" })),
    sheet: jest.fn(async () => sheet()),
    remove,
  }
}
it("pins both decoding calls to local IPC regardless of execution routing", async () => {
  localCall
    .mockReset()
    .mockResolvedValueOnce({ durationMs: 1000, sourceToken: "local-token" })
    .mockResolvedValueOnce(sheet().buffer)
  const result = await prepareMediaPackForDesktop(pack)
  expect(result.manifest.clips.idle.kind).toBe("atlas")
  expect(localCall.mock.calls).toEqual([
    ["video_get_info", { filePath: "/local/account/video.webm" }],
    [
      "plugin_media_get_video_frame",
      {
        sourceToken: "local-token",
        time: 0,
        animationSheet: { fps: 24, frameCount: 24, maxEdge: 256, format: "webp" },
      },
    ],
  ])
  expect(removeFile).toHaveBeenCalledWith(
    expect.stringMatching(/^pet-media-staging\/acct\/database\/.+\.webm$/)
  )
})
it("converts video to an alpha-preserving atlas once and removes staging files", async () => {
  const io = deps(),
    result = await prepareMediaPackForDesktop(pack, io)
  expect(io.sheet).toHaveBeenCalledWith("authorized", {
    fps: 24,
    frameCount: 24,
    maxEdge: 256,
    format: "webp",
  })
  expect(result.manifest.clips.idle).toMatchObject({
    kind: "atlas",
    frameWidth: 256,
    frameHeight: 144,
    frameCount: 24,
    columns: 16,
  })
  expect(result.entries).toHaveLength(1)
  expect(result.entries[0].path).toMatch(/\.webp$/)
  expect(result.entries[0].blob.type).toBe("image/webp")
  expect(result.totalBytes).toBe(24)
  expect(io.remove).toHaveBeenCalledTimes(1)
})

it.each(["dimensions", "signature"])(
  "rejects an inconsistent compressed sheet %s",
  async (kind) => {
    const io = deps()
    const bytes = sheet()
    if (kind === "dimensions") new DataView(bytes.buffer).setUint32(0, 4095, true)
    else bytes[16] = 0
    io.sheet.mockResolvedValue(bytes)
    await expect(prepareMediaPackForDesktop(pack, io)).rejects.toMatchObject({ code: "invalid" })
    expect(io.remove).toHaveBeenCalledTimes(1)
  }
)
it("keeps frame packs unchanged and avoids native decoding", async () => {
  const io = deps(),
    frames = {
      ...pack,
      manifest: {
        ...pack.manifest,
        clips: { idle: { kind: "frames" as const, frames: ["a.webp"], frameMs: 42, loop: true } },
      },
    }
  expect(await prepareMediaPackForDesktop(frames, io)).toBe(frames)
  expect(io.stage).not.toHaveBeenCalled()
})

it("converts shared source bytes once while retaining each clip's loop policy", async () => {
  const io = deps()
  const input = {
    ...pack,
    manifest: {
      ...pack.manifest,
      clips: {
        ...pack.manifest.clips,
        happy: { kind: "video" as const, file: "idle.webm", loop: false },
      },
    },
  }
  const result = await prepareMediaPackForDesktop(input, io)
  expect(io.sheet).toHaveBeenCalledTimes(1)
  expect(result.entries).toHaveLength(1)
  expect(result.manifest.clips.happy).toMatchObject({ kind: "atlas", loop: false })
})

it("stops conversion as soon as retained outputs exceed the import budget", async () => {
  const io = deps()
  const clips = Object.fromEntries(
    ["idle", "thinking", "working", "happy"].map((id) => [
      id,
      { kind: "video" as const, file: `${id}.webm`, loop: true },
    ])
  )
  const input = {
    ...pack,
    manifest: { ...pack.manifest, clips },
    entries: Object.keys(clips).map((id) => ({ path: `${id}.webm`, blob: new Blob(["video"]) })),
    totalBytes: 20,
  }
  await expect(prepareMediaPackForDesktop(input, io)).rejects.toMatchObject({ code: "tooLarge" })
  expect(io.sheet).toHaveBeenCalledTimes(3)
  expect(io.remove).toHaveBeenCalledTimes(3)
})
it.each(["missing", "long", "corrupt"])(
  "cleans staged source and rejects %s conversion atomically",
  async (kind) => {
    const io = deps()
    if (kind === "missing") io.probe.mockRejectedValue({ code: "MISSING_DEPENDENCY" })
    if (kind === "long")
      io.probe.mockResolvedValue({ durationMs: 30000, sourceToken: "authorized" })
    if (kind === "corrupt") io.sheet.mockResolvedValue(new Uint8Array(4))
    await expect(prepareMediaPackForDesktop(pack, io as MediaPrepareDeps)).rejects.toMatchObject({
      code: kind === "missing" ? "decoderMissing" : kind === "long" ? "tooLarge" : "invalid",
    })
    expect(io.remove).toHaveBeenCalledTimes(1)
  }
)
