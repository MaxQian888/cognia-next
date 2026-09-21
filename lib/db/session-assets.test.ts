import type { ChatSession } from "@cognia/agent-config-types"
import type { AttachmentExtractedContent } from "@cognia/agent-config-types/attachment"
import { sha256Blob } from "@/lib/ocr/hash"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"
import { clearMessages, persistMessages, commitMessageDelta } from "./messages"
import { collectUnreferencedMessageMedia, messageMediaRefRows } from "./message-media-refs"
import {
  putSessionAsset,
  getSessionAsset,
  getSessionAssetMetadata,
  listSessionAssets,
  releaseSessionAsset,
  updateSessionAssetExtraction,
  clearTemporarySessionAssets,
  searchSessionAssets,
  persistMessageSessionAssets,
  hashSessionAssetSource,
  searchAttachmentSegments,
} from "./session-assets"
import type { UIMessage } from "ai"

jest.setTimeout(30_000)
const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(async () => {
  await fixture.restore()
  clearTemporarySessionAssets()
  await getDb().sessions.bulkPut(
    ["s1", "s2"].map((id) => ({ id, title: id, createdAt: 1, updatedAt: 1 }) as ChatSession)
  )
})
afterAll(fixture.dispose)

function input(assetId = "a1", sessionId = "s1") {
  return {
    assetId,
    sessionId,
    blob: new Blob(["original source"], { type: "text/plain" }),
    filename: "source.txt",
    mediaType: "text/plain",
    now: 1,
  }
}
function extraction(
  assetId: string,
  contentHash: string,
  text = "数据库使用 sqlite"
): AttachmentExtractedContent {
  return {
    attachmentId: assetId,
    contentHash,
    status: "ready",
    processor: { id: "text", version: "1" },
    segments: [{ id: "page1", text, locator: { type: "page", page: 1 } }],
  }
}

it("deduplicates immutable original bytes across sessions and isolates authorization", async () => {
  const asset = await putSessionAsset(input())
  await putSessionAsset(input("a2", "s2"))
  expect(await getDb().messageMedia.count()).toBe(1)
  expect(await getDb().messageMediaRefs.count()).toBe(2)
  expect(await getDb().messages.count()).toBe(0)
  expect((await getSessionAsset("s1", "a1"))?.blob.size).toBe(15)
  expect(await getSessionAsset("s2", "a1")).toBeUndefined()
  expect((await listSessionAssets("s1"))[0]).toEqual({ ...asset, sourceAvailable: true })
  await releaseSessionAsset("s1", "a1")
  expect(await getDb().messageMedia.count()).toBe(1)
  await releaseSessionAsset("s2", "a2")
  expect(await getDb().messageMedia.count()).toBe(0)
})

it("hashes large sources by bounded slices without reading the full original", async () => {
  const blob = new Blob([new Uint8Array(5 * 1024 * 1024).fill(47)])
  const expected = await sha256Blob(blob)
  const slice = jest.spyOn(blob, "slice")
  expect(await hashSessionAssetSource(blob)).toBe(expected)
  expect(slice).toHaveBeenCalledTimes(5)
  expect(slice.mock.calls.every(([start = 0, end = blob.size]) => end - start <= 1024 * 1024)).toBe(
    true
  )
  expect(await hashSessionAssetSource(blob)).toBe(expected)
  expect(slice).toHaveBeenCalledTimes(5)
})

it("refuses changed identity, invalid extraction, missing sessions and quota without partial writes", async () => {
  await putSessionAsset(input())
  await expect(
    putSessionAsset({ ...input(), blob: new Blob(["different"]) })
  ).rejects.toMatchObject({ code: "session_asset_identity_conflict" })
  await expect(putSessionAsset({ ...input("a2"), quotaBytes: 1 })).rejects.toMatchObject({
    code: "session_asset_quota_exceeded",
  })
  await expect(putSessionAsset(input("a3", "missing"))).rejects.toMatchObject({
    code: "session_asset_session_missing",
  })
  await expect(
    updateSessionAssetExtraction("s1", "a1", extraction("a1", "0".repeat(64)))
  ).rejects.toMatchObject({ code: "session_asset_invalid_extraction" })
  expect(await getDb().messageMedia.count()).toBe(1)
  expect(await getDb().messageMediaRefs.count()).toBe(1)
})

it("counts deduplicated bytes once but includes derived metadata in quota", async () => {
  const blob = new Blob(["x".repeat(4_000)])
  const first = await putSessionAsset({ ...input(), blob, quotaBytes: 5_500 })
  await putSessionAsset({ ...input("a2"), blob, quotaBytes: 5_500 })
  expect(await getDb().messageMedia.count()).toBe(1)
  await expect(
    putSessionAsset({
      ...input("a3"),
      blob,
      quotaBytes: 5_500,
      extractedContent: extraction("a3", first.contentHash, "x".repeat(10_000)),
    })
  ).rejects.toMatchObject({ code: "session_asset_quota_exceeded" })
})

it("keeps temporary originals in memory and releases them on teardown", async () => {
  const first = await putSessionAsset({ ...input(), temporary: true })
  await updateSessionAssetExtraction("s1", "a1", extraction("a1", first.contentHash))
  expect((await getSessionAsset("s1", "a1"))?.extractedContent?.segments).toHaveLength(1)
  expect(await getDb().messageMedia.count()).toBe(0)
  expect(await getDb().messageMediaRefs.count()).toBe(0)
  clearTemporarySessionAssets(["s2"])
  expect(await getSessionAsset("s1", "a1")).toBeDefined()
  clearTemporarySessionAssets(["s1"])
  expect(await getSessionAsset("s1", "a1")).toBeUndefined()
})

it("keeps session sources when messages are cleared or the transcript is replaced", async () => {
  await putSessionAsset(input())
  await clearMessages("s1")
  await persistMessages("s1", [])
  await collectUnreferencedMessageMedia(undefined, { graceMs: 0 })
  expect(await getSessionAsset("s1", "a1")).toBeDefined()
  expect(() => messageMediaRefRows('session-asset:["s1","a1"]', "s1", [])).toThrow(
    "reserved_session_asset_owner"
  )
})

it("saves originals before message writes and strips ephemeral Blob fields", async () => {
  const source = input()
  const contentHash = await sha256Blob(source.blob)
  const message = {
    id: "m1",
    role: "user",
    parts: [
      {
        type: "file",
        url: "blob:preview",
        filename: source.filename,
        mediaType: "text/plain",
        attachmentOriginal: source.blob,
        extractedContent: extraction("a1", contentHash),
      },
    ],
  } as unknown as UIMessage
  await commitMessageDelta("s1", { upserts: [message] })
  expect(await getSessionAsset("s1", "a1")).toBeDefined()
  const stored = await getDb().messages.get("m1")
  expect(stored?.parts[0]).not.toHaveProperty("attachmentOriginal")
  expect(stored?.parts[0]).toHaveProperty("extractedContent")
  expect(message.parts[0]).toHaveProperty("attachmentOriginal", source.blob)
})

it("refuses serialized empty Blob objects instead of claiming an original was saved", async () => {
  const source = input()
  const contentHash = await sha256Blob(source.blob)
  const message = {
    id: "bad",
    role: "user",
    parts: [
      { type: "file", attachmentOriginal: {}, extractedContent: extraction("a1", contentHash) },
    ],
  } as unknown as UIMessage
  await expect(persistMessageSessionAssets("s1", message)).rejects.toMatchObject({
    code: "session_asset_invalid_original",
  })
  expect(await getDb().messageMedia.count()).toBe(0)
})

it("searches all source segments with locators and refreshes after extraction changes", async () => {
  const first = await putSessionAsset(input())
  await updateSessionAssetExtraction("s1", "a1", extraction("a1", first.contentHash))
  const result = await searchSessionAssets("s1", "数据库 sqlite")
  expect(result.strategy).toBe("bm25")
  expect(result.hits[0]).toMatchObject({
    assetId: "a1",
    segment: { text: "数据库使用 sqlite", locator: { type: "page", page: 1 } },
  })
  expect((await searchSessionAssets("s2", "sqlite")).hits).toEqual([])
  const capped = await searchSessionAssets("s1", "sqlite", { tokenBudget: 1 })
  expect(capped.hits).toEqual([])
  expect(capped.budget).toEqual({ limit: 1, used: 0, truncated: true })
  await updateSessionAssetExtraction(
    "s1",
    "a1",
    extraction("a1", first.contentHash, "Postgres storage")
  )
  expect((await searchSessionAssets("s1", "sqlite")).hits).toEqual([])
  expect((await searchSessionAssets("s1", "Postgres")).hits).toHaveLength(1)
})

it("returns a source-located excerpt around a match in a giant page", async () => {
  const asset = await putSessionAsset(input())
  const fullText = `${"unrelated ".repeat(5_000)}DATABASE_NEEDLE${" trailing".repeat(5_000)}`
  await updateSessionAssetExtraction("s1", "a1", extraction("a1", asset.contentHash, fullText))
  const result = await searchSessionAssets("s1", "DATABASE_NEEDLE", { tokenBudget: 180 })
  expect(result.hits).toHaveLength(1)
  const hit = result.hits[0]!
  expect(hit.segment.text).toContain("DATABASE_NEEDLE")
  expect(hit.segment.locator).toEqual({ type: "page", page: 1 })
  expect(hit.segment.text).toBe(fullText.slice(hit.sourceStart, hit.sourceEnd))
  expect(result.budget.used).toBeLessThanOrEqual(180)
  expect(result.budget.truncated).toBe(true)
})

it("shares pure bounded selection before persistence and explicitly supports general summaries", () => {
  const content = extraction("local", "0".repeat(64), "Source body for a general summary")
  const assets = [
    {
      assetId: "local",
      filename: "source.txt",
      contentHash: content.contentHash,
      extractedContent: content,
    },
  ]
  expect(searchAttachmentSegments(assets, "unrelated").hits).toEqual([])
  const result = searchAttachmentSegments(assets, "summarize", {
    includeUnmatched: true,
    tokenBudget: 500,
  })
  expect(result.hits[0]).toMatchObject({
    score: 0,
    sourceStart: 0,
    sourceEnd: content.segments[0]!.text.length,
    truncated: false,
  })
  expect(result.budget.used).toBeLessThanOrEqual(500)
})

it("reports missing source bytes without dropping searchable metadata", async () => {
  const asset = await putSessionAsset(input())
  await updateSessionAssetExtraction("s1", "a1", extraction("a1", asset.contentHash))
  await getDb().messageMedia.clear()
  const scan = jest.spyOn(getDb().messageMedia, "toArray")
  expect((await listSessionAssets("s1"))[0]).toMatchObject({ sourceAvailable: false })
  expect(await getSessionAsset("s1", "a1")).toBeUndefined()
  expect((await searchSessionAssets("s1", "sqlite")).hits).toHaveLength(1)
  expect(scan).not.toHaveBeenCalled()
})

it("registers derived-only remote attachments without granting another session's source bytes", async () => {
  const source = await putSessionAsset(input("a1", "s2"))
  const content = extraction("remote", source.contentHash)
  const message = {
    id: "remote-message",
    role: "user",
    parts: [
      {
        type: "file",
        url: "",
        filename: "remote.txt",
        mediaType: "text/plain",
        extractedContent: content,
      },
    ],
  } as unknown as UIMessage
  await persistMessageSessionAssets("s1", message)
  expect((await listSessionAssets("s1"))[0]).toMatchObject({
    assetId: "remote",
    sourceAvailable: false,
  })
  expect(await getSessionAsset("s1", "remote")).toBeUndefined()
  expect((await searchSessionAssets("s1", "sqlite")).hits).toHaveLength(1)
  await releaseSessionAsset("s1", "remote")
  await persistMessageSessionAssets("s1", message)
  expect(await listSessionAssets("s1")).toEqual([])
  expect((await searchSessionAssets("s1", "sqlite")).hits).toEqual([])
  expect(await getSessionAsset("s2", "a1")).toBeDefined()
})

it("does not downgrade a retained source when an older derived snapshot is persisted", async () => {
  const asset = await putSessionAsset(input())
  const current = extraction("a1", asset.contentHash, "current SQLite")
  await updateSessionAssetExtraction("s1", "a1", current)
  await persistMessageSessionAssets("s1", {
    id: "stale",
    role: "user",
    parts: [
      {
        type: "text",
        text: "",
        extractedContent: extraction("a1", asset.contentHash, "stale Mongo"),
      },
    ],
  } as unknown as UIMessage)
  expect((await getSessionAsset("s1", "a1"))?.extractedContent).toEqual(current)
})

it("persists unchanged source content idempotently without revision churn", async () => {
  const first = await putSessionAsset(input())
  const scan = jest.spyOn(getDb().messageMediaRefs, "filter")
  expect(await putSessionAsset(input())).toEqual(first)
  expect(scan).not.toHaveBeenCalled()
})

it("rolls back source deletion if binary cleanup fails", async () => {
  await putSessionAsset(input())
  const failure = () => {
    throw new Error("disk-failure")
  }
  getDb().messageMedia.hook("deleting", failure)
  try {
    await expect(releaseSessionAsset("s1", "a1")).rejects.toThrow("disk-failure")
  } finally {
    getDb().messageMedia.hook("deleting").unsubscribe(failure)
  }
  expect(await getSessionAsset("s1", "a1")).toBeDefined()
})

it("reads one source metadata by owner without loading source blobs or other assets", async () => {
  await putSessionAsset(input())
  const rows = jest.spyOn(getDb().messageMedia, "get")
  expect(await getSessionAssetMetadata("s1", "a1")).toMatchObject({
    assetId: "a1",
    sourceAvailable: true,
  })
  expect(await getSessionAssetMetadata("s2", "a1")).toBeUndefined()
  expect(rows).not.toHaveBeenCalled()
  await getDb().messageMedia.clear()
  expect(await getSessionAssetMetadata("s1", "a1")).toMatchObject({ sourceAvailable: false })
  await releaseSessionAsset("s1", "a1")
  expect(await getSessionAssetMetadata("s1", "a1")).toBeUndefined()
})

it("retains original audio/video media type instead of its text or image projection type", async () => {
  const original = new Blob(["audio bytes"], { type: "audio/webm" })
  const contentHash = await sha256Blob(original)
  await persistMessageSessionAssets("s1", {
    id: "audio",
    role: "user",
    parts: [
      {
        type: "file",
        mediaType: "text/plain",
        filename: "meeting.webm",
        attachmentOriginal: original,
        extractedContent: extraction("audio", contentHash),
      },
    ],
  } as unknown as UIMessage)
  expect(await getSessionAssetMetadata("s1", "audio")).toMatchObject({ mediaType: "audio/webm" })
})
