/** @jest-environment jsdom */
// Coverage for the object-URL registry: refcounting, dedupe of concurrent
// resolves, thumbnail selection, byte-bounded idle eviction and revocation.
//
// `getMessageMedia` is mocked rather than driven through fake-indexeddb,
// because fake-indexeddb does not round-trip Blobs (see `ingest-media.test.ts`)
// and every assertion here is about the registry's bookkeeping, not storage.

import {
  IDLE_BYTE_BUDGET,
  __TESTING__,
  acquireMedia,
  releaseAllMedia,
  releaseMedia,
} from "./resolve-media"
import { getMessageMedia, mediaRef, putMessageMedia } from "@/lib/db/message-media"

jest.mock("@/lib/db/message-media", () => {
  const actual = jest.requireActual("@/lib/db/message-media")
  return { ...actual, getMessageMedia: jest.fn(), putMessageMedia: jest.fn() }
})

const getMedia = getMessageMedia as jest.MockedFunction<typeof getMessageMedia>
const putMedia = putMessageMedia as jest.MockedFunction<typeof putMessageMedia>

let created: string[] = []
let revoked: string[] = []
let urlCounter = 0

beforeEach(() => {
  __TESTING__.reset()
  getMedia.mockReset()
  putMedia.mockReset()
  putMedia.mockResolvedValue(mediaRef("h"))
  created = []
  revoked = []
  urlCounter = 0
  URL.createObjectURL = jest.fn(() => {
    const url = `blob:mock/${urlCounter++}`
    created.push(url)
    return url
  })
  URL.revokeObjectURL = jest.fn((url: string) => {
    revoked.push(url)
  })
})

function row(over: Record<string, unknown> = {}) {
  return {
    hash: "h",
    mediaType: "image/jpeg",
    width: 1568,
    height: 980,
    blob: { size: 1_000 } as unknown as Blob,
    byteSize: 1_000,
    createdAt: 1,
    lastUsedAt: 1,
    ...over,
  } as Awaited<ReturnType<typeof getMessageMedia>>
}

describe("acquireMedia", () => {
  it("resolves a reference to an object URL with its geometry", async () => {
    getMedia.mockResolvedValue(row())

    const resolved = await acquireMedia(mediaRef("h"))

    expect(resolved).toEqual({
      url: "blob:mock/0",
      mediaType: "image/jpeg",
      width: 1568,
      height: 980,
      byteSize: 1_000,
      isThumbnail: false,
    })
  })

  it("returns null for anything that is not a media reference", async () => {
    expect(await acquireMedia("data:image/png;base64,AAAA")).toBeNull()
    expect(await acquireMedia("")).toBeNull()
    expect(getMedia).not.toHaveBeenCalled()
  })

  it("returns null for a dangling reference rather than an empty box", async () => {
    getMedia.mockResolvedValue(undefined)

    expect(await acquireMedia(mediaRef("gone"))).toBeNull()
  })

  it("loads a missing remote blob once and caches it in the media store", async () => {
    getMedia.mockResolvedValue(undefined)
    const remoteRow = row({ hash: "remote" })!
    const loadMissing = jest.fn(async () => remoteRow!)

    const resolved = await acquireMedia(mediaRef("remote"), { loadMissing })

    expect(loadMissing).toHaveBeenCalledWith({ hash: "remote", variant: "canonical" })
    expect(putMedia).toHaveBeenCalledWith(remoteRow)
    expect(resolved).toMatchObject({ mediaType: "image/jpeg", byteSize: 1_000 })
  })

  it("requests only the thumbnail variant for a visible gallery tile", async () => {
    getMedia.mockResolvedValue(undefined)
    const loadMissing = jest.fn(async () =>
      row({
        hash: "remote-thumb",
        canonicalAvailable: false,
        thumbBlob: { size: 40 } as Blob,
      })
    )

    const resolved = await acquireMedia(mediaRef("remote-thumb"), {
      thumbnail: true,
      loadMissing,
    })

    expect(loadMissing).toHaveBeenCalledWith({ hash: "remote-thumb", variant: "thumbnail" })
    expect(resolved).toMatchObject({ isThumbnail: true, byteSize: 40 })
  })

  it("fetches canonical bytes when only a remote thumbnail is cached", async () => {
    getMedia.mockResolvedValue(
      row({ hash: "partial", canonicalAvailable: false, thumbBlob: { size: 40 } as Blob })
    )
    const loadMissing = jest.fn(async () => row({ hash: "partial", canonicalAvailable: true }))

    await acquireMedia(mediaRef("partial"), { loadMissing })

    expect(loadMissing).toHaveBeenCalledWith({ hash: "partial", variant: "canonical" })
  })

  it("rejects a remote row whose content address does not match the reference", async () => {
    getMedia.mockResolvedValue(undefined)

    expect(
      await acquireMedia(mediaRef("expected"), {
        loadMissing: async () => row({ hash: "different" })!,
      })
    ).toBeNull()
    expect(putMedia).not.toHaveBeenCalled()
  })

  it("does not call the remote loader when the blob is already cached", async () => {
    getMedia.mockResolvedValue(row())
    const loadMissing = jest.fn()

    await acquireMedia(mediaRef("h"), { loadMissing })

    expect(loadMissing).not.toHaveBeenCalled()
  })

  it("mints one URL for repeat holders of the same reference", async () => {
    getMedia.mockResolvedValue(row())

    const first = await acquireMedia(mediaRef("h"))
    const second = await acquireMedia(mediaRef("h"))

    expect(second!.url).toBe(first!.url)
    expect(created).toHaveLength(1)
    expect(getMedia).toHaveBeenCalledTimes(1)
    expect(__TESTING__.stats().holders).toBe(2)
  })

  it("de-dupes concurrent resolves of the same reference", async () => {
    // Two rows scrolling in on the same frame must not both read and both mint.
    getMedia.mockResolvedValue(row())

    const [a, b] = await Promise.all([acquireMedia(mediaRef("h")), acquireMedia(mediaRef("h"))])

    expect(a!.url).toBe(b!.url)
    expect(created).toHaveLength(1)
    expect(getMedia).toHaveBeenCalledTimes(1)
    expect(__TESTING__.stats().holders).toBe(2)
  })

  it("reports null to every waiter when a concurrent resolve finds nothing", async () => {
    getMedia.mockResolvedValue(undefined)

    const [a, b] = await Promise.all([acquireMedia(mediaRef("x")), acquireMedia(mediaRef("x"))])

    expect(a).toBeNull()
    expect(b).toBeNull()
  })

  it("prefers the thumbnail when one was stored", async () => {
    getMedia.mockResolvedValue(
      row({
        thumbBlob: { size: 50 } as unknown as Blob,
        thumbWidth: 512,
        thumbHeight: 320,
      })
    )

    const resolved = await acquireMedia(mediaRef("h"), { thumbnail: true })

    expect(resolved).toMatchObject({ width: 512, height: 320, byteSize: 50, isThumbnail: true })
  })

  it("falls back to the canonical frame when no thumbnail exists", async () => {
    getMedia.mockResolvedValue(row())

    const resolved = await acquireMedia(mediaRef("h"), { thumbnail: true })

    expect(resolved).toMatchObject({ width: 1568, isThumbnail: false })
  })

  it("keeps the thumbnail and the canonical frame as separate resolutions", async () => {
    getMedia.mockResolvedValue(row({ thumbBlob: { size: 50 } as unknown as Blob }))

    const thumb = await acquireMedia(mediaRef("h"), { thumbnail: true })
    const full = await acquireMedia(mediaRef("h"))

    expect(thumb!.url).not.toBe(full!.url)
    expect(__TESTING__.stats().entries).toBe(2)
  })

  it("returns null when the runtime cannot mint object URLs", async () => {
    getMedia.mockResolvedValue(row())
    const real = URL.createObjectURL
    ;(URL as { createObjectURL?: unknown }).createObjectURL = undefined

    expect(await acquireMedia(mediaRef("h"))).toBeNull()

    URL.createObjectURL = real
  })
})

describe("releaseMedia", () => {
  it("keeps the URL alive while another holder remains", async () => {
    getMedia.mockResolvedValue(row())
    await acquireMedia(mediaRef("h"))
    await acquireMedia(mediaRef("h"))

    releaseMedia(mediaRef("h"))

    expect(revoked).toEqual([])
    expect(__TESTING__.stats().holders).toBe(1)
  })

  it("keeps a released entry resolved so scrolling back does not re-read", async () => {
    getMedia.mockResolvedValue(row())
    await acquireMedia(mediaRef("h"))

    releaseMedia(mediaRef("h"))

    expect(revoked).toEqual([])
    expect(__TESTING__.stats().entries).toBe(1)

    await acquireMedia(mediaRef("h"))
    expect(getMedia).toHaveBeenCalledTimes(1)
  })

  it("ignores a release for something never acquired", () => {
    expect(() => releaseMedia(mediaRef("nope"))).not.toThrow()
    expect(() => releaseMedia("not-a-ref")).not.toThrow()
  })

  it("ignores an extra release rather than going negative", async () => {
    getMedia.mockResolvedValue(row())
    await acquireMedia(mediaRef("h"))

    releaseMedia(mediaRef("h"))
    releaseMedia(mediaRef("h"))

    expect(__TESTING__.stats().holders).toBe(0)
  })
})

describe("idle eviction", () => {
  it("revokes the least-recently-idle entries once the byte budget is exceeded", async () => {
    const big = Math.ceil(IDLE_BYTE_BUDGET / 2) + 1
    for (const hash of ["a", "b", "c"]) {
      getMedia.mockResolvedValue(row({ hash, byteSize: big }))
      await acquireMedia(mediaRef(hash))
    }

    releaseMedia(mediaRef("a"))
    releaseMedia(mediaRef("b"))
    releaseMedia(mediaRef("c"))

    // Three oversized frames idle at once; the oldest go until the budget holds.
    expect(revoked.length).toBeGreaterThan(0)
    expect(revoked[0]).toBe(created[0])
    expect(__TESTING__.stats().idleBytes).toBeLessThanOrEqual(IDLE_BYTE_BUDGET)
  })

  it("never evicts an entry that still has a holder", async () => {
    const big = IDLE_BYTE_BUDGET + 1
    getMedia.mockResolvedValue(row({ hash: "held", byteSize: big }))
    await acquireMedia(mediaRef("held"))
    getMedia.mockResolvedValue(row({ hash: "idle", byteSize: big }))
    await acquireMedia(mediaRef("idle"))

    releaseMedia(mediaRef("idle"))

    // Revoking a URL an <img> still points at would blank it on screen.
    expect(revoked).not.toContain(created[0])
    expect(__TESTING__.stats().holders).toBe(1)
  })

  it("keeps everything while the budget is respected", async () => {
    getMedia.mockResolvedValue(row({ byteSize: 10 }))
    await acquireMedia(mediaRef("h"))

    releaseMedia(mediaRef("h"))

    expect(revoked).toEqual([])
  })
})

describe("releaseAllMedia", () => {
  it("revokes everything including held entries", async () => {
    getMedia.mockResolvedValue(row({ hash: "a" }))
    await acquireMedia(mediaRef("a"))
    getMedia.mockResolvedValue(row({ hash: "b" }))
    await acquireMedia(mediaRef("b"))

    releaseAllMedia()

    expect(revoked).toHaveLength(2)
    expect(__TESTING__.stats()).toEqual({ entries: 0, idleBytes: 0, holders: 0 })
  })

  it("is safe when the runtime has no revoke", () => {
    const real = URL.revokeObjectURL
    ;(URL as { revokeObjectURL?: unknown }).revokeObjectURL = undefined

    expect(() => releaseAllMedia()).not.toThrow()

    URL.revokeObjectURL = real
  })
})
