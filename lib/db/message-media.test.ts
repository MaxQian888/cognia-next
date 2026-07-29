/** @jest-environment jsdom */
// Coverage for the content-addressed chat-media store: reference parsing,
// hash-keyed dedupe, batch reads, byte accounting and orphan collection. Uses
// fake-indexeddb so the real Dexie query path runs in memory.

import "fake-indexeddb/auto"
import {
  MEDIA_REF_PREFIX,
  collectOrphanedMedia,
  deleteMessageMedia,
  getManyMessageMedia,
  getMessageMedia,
  hasMessageMedia,
  isMediaRef,
  mediaRef,
  messageMediaByteTotal,
  parseMediaRef,
  putMessageMedia,
  type MessageMediaRow,
} from "./message-media"
import { getDb, whenSeeded, __resetDbForTesting } from "./schema"

// A cold open of the full schema chain crosses Jest's default 5s hook timeout
// under coverage instrumentation. Mirrors the repo pattern for high-version
// tables.
jest.setTimeout(30_000)

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

function makeRow(over: Partial<MessageMediaRow> = {}): MessageMediaRow {
  return {
    hash: over.hash ?? "abc123",
    mediaType: "image/jpeg",
    width: 1568,
    height: 980,
    blob: new Blob(["canonical"], { type: "image/jpeg" }),
    byteSize: 9,
    createdAt: 1_000,
    lastUsedAt: 1_000,
    ...over,
  }
}

describe("media references", () => {
  it("round-trips a hash through the reference form", () => {
    expect(mediaRef("deadbeef")).toBe(`${MEDIA_REF_PREFIX}deadbeef`)
    expect(parseMediaRef(mediaRef("deadbeef"))).toBe("deadbeef")
  })

  it("rejects anything that is not a media reference", () => {
    // The dual-read path leans on this: a legacy message still carries a
    // `data:` URL, and it must not be mistaken for a reference.
    expect(parseMediaRef("data:image/png;base64,AAAA")).toBeNull()
    expect(parseMediaRef("https://example.com/a.png")).toBeNull()
    expect(parseMediaRef("")).toBeNull()
    expect(parseMediaRef(undefined)).toBeNull()
    expect(parseMediaRef(null)).toBeNull()
    // Prefix with no hash is not a reference either.
    expect(parseMediaRef(MEDIA_REF_PREFIX)).toBeNull()
  })

  it("exposes the same judgement as a predicate", () => {
    expect(isMediaRef(mediaRef("x"))).toBe(true)
    expect(isMediaRef("data:image/png;base64,AA")).toBe(false)
  })
})

describe("putMessageMedia", () => {
  it("stores a row and returns its reference", async () => {
    const ref = await putMessageMedia(makeRow({ hash: "h1" }))

    expect(ref).toBe(mediaRef("h1"))
    expect(await hasMessageMedia("h1")).toBe(true)
    expect(await hasMessageMedia(ref)).toBe(true)
  })

  it("stores identical content once, however many turns reference it", async () => {
    await putMessageMedia(makeRow({ hash: "same" }))
    await putMessageMedia(makeRow({ hash: "same" }))
    await putMessageMedia(makeRow({ hash: "same" }))

    expect(await getDb().messageMedia.count()).toBe(1)
  })

  it("does not let a re-store drop an original captured by the first write", async () => {
    // A user uploads a photo (original kept), then an agent screenshots the
    // same frame. The second write must not erase the original.
    await putMessageMedia(
      makeRow({
        hash: "shared",
        originalBlob: new Blob(["original"], { type: "image/png" }),
        originalByteSize: 8,
        originalMediaType: "image/png",
      })
    )
    await putMessageMedia(makeRow({ hash: "shared" }))

    const row = await getMessageMedia("shared")
    expect(row?.originalByteSize).toBe(8)
    expect(row?.originalMediaType).toBe("image/png")
  })

  it("refreshes lastUsedAt on a re-store so a live image is not collectable", async () => {
    await putMessageMedia(makeRow({ hash: "touch", lastUsedAt: 1_000 }))
    await putMessageMedia(makeRow({ hash: "touch", lastUsedAt: 5_000 }))

    const row = await getDb().messageMedia.get("touch")
    expect(row?.lastUsedAt).toBe(5_000)
  })
})

describe("reads", () => {
  it("resolves a row by hash or by reference", async () => {
    await putMessageMedia(makeRow({ hash: "h2", width: 800 }))

    expect((await getMessageMedia("h2"))?.width).toBe(800)
    expect((await getMessageMedia(mediaRef("h2")))?.width).toBe(800)
  })

  it("returns undefined for a reference nothing stored", async () => {
    expect(await getMessageMedia(mediaRef("missing"))).toBeUndefined()
    expect(await hasMessageMedia("missing")).toBe(false)
  })

  it("touches lastUsedAt on read", async () => {
    await putMessageMedia(makeRow({ hash: "h3", lastUsedAt: 1 }))

    await getMessageMedia("h3")

    const row = await getDb().messageMedia.get("h3")
    expect(row!.lastUsedAt).toBeGreaterThan(1)
  })

  it("batch-reads several references and skips the missing ones", async () => {
    await putMessageMedia(makeRow({ hash: "a" }))
    await putMessageMedia(makeRow({ hash: "b" }))

    const rows = await getManyMessageMedia([mediaRef("a"), mediaRef("gone"), "b"])

    expect(rows.map((row) => row.hash).sort()).toEqual(["a", "b"])
  })

  it("returns nothing for an empty batch without touching the database", async () => {
    expect(await getManyMessageMedia([])).toEqual([])
  })

  it("deletes by hash or reference", async () => {
    await putMessageMedia(makeRow({ hash: "d1" }))
    await putMessageMedia(makeRow({ hash: "d2" }))

    await deleteMessageMedia("d1")
    await deleteMessageMedia(mediaRef("d2"))

    expect(await getDb().messageMedia.count()).toBe(0)
  })
})

describe("messageMediaByteTotal", () => {
  it("is zero for an empty store", async () => {
    expect(await messageMediaByteTotal()).toBe(0)
  })

  it("counts canonical and original bytes together", async () => {
    await putMessageMedia(makeRow({ hash: "x", byteSize: 100 }))
    await putMessageMedia(makeRow({ hash: "y", byteSize: 200, originalByteSize: 900 }))

    expect(await messageMediaByteTotal()).toBe(1200)
  })
})

describe("collectOrphanedMedia", () => {
  it("deletes only what nothing references", async () => {
    await putMessageMedia(makeRow({ hash: "live", createdAt: 0 }))
    await putMessageMedia(makeRow({ hash: "dead", createdAt: 0 }))

    const removed = await collectOrphanedMedia([mediaRef("live")], { now: 1_000_000 })

    expect(removed).toBe(1)
    expect(await hasMessageMedia("live")).toBe(true)
    expect(await hasMessageMedia("dead")).toBe(false)
  })

  it("spares media younger than the grace window", async () => {
    // Media is written just before the message that references it is
    // persisted. Collecting inside that window would delete a live image.
    await putMessageMedia(makeRow({ hash: "fresh", createdAt: 990_000 }))

    const removed = await collectOrphanedMedia([], { now: 1_000_000, graceMs: 60_000 })

    expect(removed).toBe(0)
    expect(await hasMessageMedia("fresh")).toBe(true)
  })

  it("collects once the grace window has passed", async () => {
    await putMessageMedia(makeRow({ hash: "stale", createdAt: 900_000 }))

    expect(await collectOrphanedMedia([], { now: 1_000_000, graceMs: 60_000 })).toBe(1)
  })

  it("ignores live entries that are not references", async () => {
    await putMessageMedia(makeRow({ hash: "orphan", createdAt: 0 }))

    // A legacy `data:` URL in the live set must not be read as protecting
    // some hash — it protects nothing.
    const removed = await collectOrphanedMedia(["data:image/png;base64,AAAA"], { now: 1_000_000 })

    expect(removed).toBe(1)
  })

  it("does nothing when there is nothing to collect", async () => {
    expect(await collectOrphanedMedia([], { now: 1_000_000 })).toBe(0)
  })
})
