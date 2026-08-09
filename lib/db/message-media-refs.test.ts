import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"
import {
  collectMessageMediaHashes,
  collectUnreferencedMessageMedia,
  isMessageMediaReferencedBySession,
  listMessageMediaRefsForSession,
} from "./message-media-refs"
import { mediaRef, putMessageMedia, type MessageMediaRow } from "./message-media"

jest.setTimeout(30_000)

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

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
      ])
    ).toEqual(["a", "b"])
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
})
