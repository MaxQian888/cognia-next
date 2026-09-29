import {
  DEFAULT_MAX_VIDEO_BYTES,
  getVideoJobEngine,
  getVideoJobHost,
  installVideoJobHost,
} from "./host"
import type { MediaGenerationJobRow } from "./types"

describe("video job host", () => {
  it("defaults to an in-memory host that keeps results inline and takes only image bytes", async () => {
    const host = getVideoJobHost()
    expect(host.maxResultBytes).toBe(DEFAULT_MAX_VIDEO_BYTES)
    expect(() => host.getSnapshot()).toThrow("pass a snapshot")
    await expect(
      host.resolveStartFrame(
        { kind: "bytes", data: new Uint8Array([1]), mediaType: "image/png" },
        {
          surface: "executor",
        }
      )
    ).resolves.toEqual({ data: new Uint8Array([1]), mediaType: "image/png" })
    await expect(
      host.resolveStartFrame({ kind: "media", ref: "cognia-media:x" }, { surface: "executor" })
    ).rejects.toThrow("image bytes")
    const result = await host.materialize(
      {} as MediaGenerationJobRow,
      new Blob([new Uint8Array([4, 5])], { type: "video/mp4" })
    )
    expect(result).toMatchObject({
      content: { kind: "inline" },
      byteSize: 2,
      mediaType: "video/mp4",
    })
  })

  it("installs a host and restores the previous engine", () => {
    const before = getVideoJobEngine()
    const restore = installVideoJobHost({ ...getVideoJobHost(), maxResultBytes: 1 })
    expect(getVideoJobHost().maxResultBytes).toBe(1)
    expect(getVideoJobEngine()).not.toBe(before)
    restore()
    expect(getVideoJobEngine()).toBe(before)
  })
})
