/** @jest-environment jsdom */
import type { FilesEntry } from "../types"
import { createRemoteMediaLoader } from "./media-loader"

const entry = { key: "image:h", kind: "image", sourceId: "h" } as FilesEntry

describe("remote media loader", () => {
  it("caches a thumbnail read as both the blob and the thumb, canonical still owed", async () => {
    const readMedia = jest.fn(async () => ({
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: "image/png",
    }))
    const row = await createRemoteMediaLoader(
      { readMedia },
      entry
    )({ hash: "h", variant: "thumbnail" })
    expect(readMedia).toHaveBeenCalledWith(entry, "thumbnail")
    expect(row).toMatchObject({
      hash: "h",
      mediaType: "image/png",
      byteSize: 3,
      canonicalAvailable: false,
    })
    expect(row!.thumbBlob).toBe(row!.blob)
  })

  it("marks a canonical read as the full frame", async () => {
    const readMedia = jest.fn(async () => ({ bytes: new Uint8Array([1]), mediaType: "image/jpeg" }))
    const row = await createRemoteMediaLoader(
      { readMedia },
      entry
    )({ hash: "h", variant: "canonical" })
    expect(row).toMatchObject({ canonicalAvailable: true })
    expect(row).not.toHaveProperty("thumbBlob")
  })

  it("lets a failed read fail the acquire", async () => {
    const readMedia = jest.fn(async () => Promise.reject(new Error("offline")))
    await expect(
      createRemoteMediaLoader({ readMedia }, entry)({ hash: "h", variant: "canonical" })
    ).rejects.toThrow("offline")
  })
})
