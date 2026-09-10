import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"
import {
  collectMessageMediaHashes,
  collectUnreferencedMessageMedia,
  isMessageMediaReferencedBySession,
  listMessageMediaRefsForSession,
  messageMediaRefRows,
} from "./message-media-refs"
import { mediaRef, putMessageMedia, type MessageMediaRow } from "./message-media"

jest.setTimeout(30_000)

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)
afterEach(() => jest.restoreAllMocks())

function media(hash: string, createdAt = 1): MessageMediaRow {
  return {
    hash,
    mediaType: "image/png",
    width: 1,
    height: 1,
    blob: new Blob([hash], { type: "image/png" }),
    byteSize: hash.length,
    createdAt,
    lastUsedAt: createdAt,
  }
}

describe("collectMessageMediaHashes", () => {
  it("finds and deduplicates references nested in message parts", () => {
    expect(
      collectMessageMediaHashes([
        { type: "file", url: mediaRef("a") },
        { type: "tool-result", output: { preview: mediaRef("b"), again: mediaRef("a") } },
        { type: "text", text: "cognia-media:not-a-field-value" },
        { type: "file", url: "https://example.com/image.png", size: 1, metadata: null },
      ])
    ).toEqual(["a", "b"])
  })

  it("builds one ledger row per distinct hash", () => {
    expect(messageMediaRefRows("m1", "s1", [{ url: mediaRef("a") }])).toEqual([
      { messageId: "m1", sessionId: "s1", hash: "a" },
    ])
  })
})

describe("reference queries and collection", () => {
  it("answers session-scoped authorization without reading message payloads", async () => {
    await getDb().messageMediaRefs.bulkPut([
      { messageId: "m1", sessionId: "s1", hash: "shared" },
      { messageId: "m2", sessionId: "s2", hash: "shared" },
    ])

    await expect(isMessageMediaReferencedBySession("s1", mediaRef("shared"))).resolves.toBe(true)
    await expect(isMessageMediaReferencedBySession("s3", mediaRef("shared"))).resolves.toBe(false)
    await expect(isMessageMediaReferencedBySession("s2", "shared")).resolves.toBe(true)
    await expect(listMessageMediaRefsForSession("s1")).resolves.toEqual([
      { messageId: "m1", sessionId: "s1", hash: "shared" },
    ])
  })

  it("deletes only old media with no remaining reference", async () => {
    await putMessageMedia(media("live"))
    await putMessageMedia(media("dead"))
    await getDb().messageMediaRefs.put({ messageId: "m1", sessionId: "s1", hash: "live" })

    await expect(
      collectUnreferencedMessageMedia(["live", "dead"], { now: 1_000_000, graceMs: 60_000 })
    ).resolves.toBe(1)
    expect(await getDb().messageMedia.get("live")).toBeDefined()
    expect(await getDb().messageMedia.get("dead")).toBeUndefined()
  })

  it("keeps freshly ingested media while persistence is still in flight", async () => {
    await putMessageMedia(media("fresh", 990_000))

    await expect(
      collectUnreferencedMessageMedia(["fresh"], { now: 1_000_000, graceMs: 60_000 })
    ).resolves.toBe(0)
  })

  it("checks only the candidate hash instead of scanning unrelated media or references", async () => {
    const db = getDb()
    await db.messageMedia.bulkPut(Array.from({ length: 1000 }, (_, i) => media(`h${i}`)))
    await db.messageMediaRefs.put({ messageId: "m1", sessionId: "s1", hash: "h1" })
    const mediaScan = jest.spyOn(db.messageMedia, "each")
    const referenceScan = jest.spyOn(db.messageMediaRefs, "orderBy")
    const mediaReads = jest.spyOn(db.messageMedia, "bulkGet")

    await expect(
      collectUnreferencedMessageMedia(["h0", mediaRef("h0")], { now: 1_000_000 })
    ).resolves.toBe(1)

    expect(mediaScan).not.toHaveBeenCalled()
    expect(referenceScan).not.toHaveBeenCalled()
    expect(mediaReads).toHaveBeenCalledWith(["h0"])
    expect(await db.messageMedia.get("h0")).toBeUndefined()
    expect(await db.messageMedia.count()).toBe(999)
  })

  it("preserves references across sessions and ignores missing candidates", async () => {
    const db = getDb()
    await db.messageMedia.bulkPut([media("shared"), media("orphan"), media("unrelated")])
    await db.messageMediaRefs.bulkPut([
      { messageId: "m1", sessionId: "s1", hash: "shared" },
      { messageId: "m2", sessionId: "s2", hash: "shared" },
    ])
    await db.messageMediaRefs.where("sessionId").equals("s1").delete()

    await expect(
      collectUnreferencedMessageMedia(new Set([mediaRef("shared"), "orphan", "missing"]), {
        now: 1_000_000,
      })
    ).resolves.toBe(1)
    expect(await db.messageMedia.get("shared")).toBeDefined()
    expect(await db.messageMedia.get("unrelated")).toBeDefined()
  })

  it("performs no database work for empty candidates", async () => {
    const db = getDb()
    const transaction = jest.spyOn(db, "transaction")
    const referenceScan = jest.spyOn(db.messageMediaRefs, "orderBy")
    const mediaScan = jest.spyOn(db.messageMedia, "each")

    await expect(collectUnreferencedMessageMedia([])).resolves.toBe(0)
    expect(transaction).not.toHaveBeenCalled()
    expect(referenceScan).not.toHaveBeenCalled()
    expect(mediaScan).not.toHaveBeenCalled()
  })

  it("uses the default clock and grace period, including the exact expiration boundary", async () => {
    jest.spyOn(Date, "now").mockReturnValue(1_000_000)
    await getDb().messageMedia.bulkPut([media("expired", 940_000), media("fresh", 940_001)])

    await expect(collectUnreferencedMessageMedia(["expired", "fresh"])).resolves.toBe(1)
    expect(await getDb().messageMedia.get("fresh")).toBeDefined()
  })

  it("rolls candidate deletions back if the collection transaction fails", async () => {
    const db = getDb()
    await db.messageMedia.bulkPut([media("first"), media("second")])
    const bulkDelete = db.messageMedia.bulkDelete.bind(db.messageMedia)
    jest.spyOn(db.messageMedia, "bulkDelete").mockImplementationOnce((hashes) =>
      bulkDelete(hashes).then(() => {
        throw new Error("collection failed")
      })
    )

    await expect(
      collectUnreferencedMessageMedia(["first", "second"], { now: 1_000_000 })
    ).rejects.toThrow("collection failed")
    expect(await db.messageMedia.count()).toBe(2)
  })

  it("still collects every old unreferenced row when candidates are omitted", async () => {
    const db = getDb()
    await db.messageMedia.bulkPut([media("live"), media("orphan"), media("fresh", 990_000)])
    await db.messageMediaRefs.put({ messageId: "m1", sessionId: "s1", hash: "live" })

    await expect(collectUnreferencedMessageMedia(undefined, { now: 1_000_000 })).resolves.toBe(1)
    expect(await db.messageMedia.get("live")).toBeDefined()
    expect(await db.messageMedia.get("fresh")).toBeDefined()
  })
})
