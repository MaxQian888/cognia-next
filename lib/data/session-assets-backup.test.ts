import type { ChatSession } from "@cognia/agent-config-types"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getSessionAsset, putSessionAsset } from "@/lib/db/session-assets"
import { readBlobAsArrayBuffer } from "@cognia/ocr/blob-utils"
import { exportSessionAssetRecords, prepareSessionAssetBackup } from "./session-assets-backup"
import { buildBackupPackage } from "./build-package"
import { applyBackupPackage } from "./apply-package"
import { buildBackupSections } from "./build-stream"
import type { BackupPayloadV3 } from "./types"

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)

async function seed(sessionId = "source") {
  await getDb().sessions.put({
    id: sessionId,
    title: "Sources",
    createdAt: 1,
    updatedAt: 1,
  } as ChatSession)
  const blob = new Blob([new Uint8Array(150_000).fill(47)], { type: "application/pdf" })
  const asset = await putSessionAsset({
    sessionId,
    assetId: "a",
    filename: "report.pdf",
    mediaType: blob.type,
    blob,
  })
  return { asset, blob }
}

async function records() {
  const payload: BackupPayloadV3 = {}
  for await (const record of exportSessionAssetRecords(new Set(["source"]))) {
    if (record.section === "sessionAssets") (payload.sessionAssets ??= []).push(...record.rows)
    else (payload.sessionAssetSourceChunks ??= []).push(...record.rows)
  }
  return payload
}

it("exports bounded chunks, validates content hashes and restores exact original bytes", async () => {
  const { blob } = await seed()
  const payload = await records()
  expect(payload.sessionAssetSourceChunks).toHaveLength(4)
  expect(payload.sessionAssetSourceChunks!.every((chunk) => chunk.data.length <= 65536)).toBe(true)
  const prepared = await prepareSessionAssetBackup(
    payload.sessionAssets,
    payload.sessionAssetSourceChunks,
    new Set(["source"])
  )
  expect(await readBlobAsArrayBuffer([...prepared.sources.values()][0]!)).toEqual(
    await readBlobAsArrayBuffer(blob)
  )
  await expect(
    prepareSessionAssetBackup(
      payload.sessionAssets,
      payload.sessionAssetSourceChunks!.slice(0, -1),
      new Set(["source"])
    )
  ).rejects.toThrow("incomplete")
  const corrupt = payload.sessionAssetSourceChunks!.map((chunk, index) =>
    index === 0 ? { ...chunk, data: "AA==" + chunk.data.slice(4) } : chunk
  )
  await expect(
    prepareSessionAssetBackup(payload.sessionAssets, corrupt, new Set(["source"]))
  ).rejects.toThrow()
  await expect(
    prepareSessionAssetBackup(
      payload.sessionAssets,
      payload.sessionAssetSourceChunks,
      new Set(["other"])
    )
  ).rejects.toThrow("invalid")
})

it("fails backup explicitly when original bytes are absent and never exports another session", async () => {
  await seed()
  const excluded = []
  for await (const record of exportSessionAssetRecords(new Set(["other"]))) excluded.push(record)
  expect(excluded).toEqual([])
  await getDb().messageMedia.clear()
  await expect(records()).rejects.toThrow("session_asset_backup_source_missing")
})

it("round trips JSON backups and duplicates the whole session source bundle", async () => {
  const { asset, blob } = await seed()
  await getDb().messages.put({
    id: "m",
    sessionId: "source",
    role: "user",
    parts: [{ type: "text", text: "source" }],
    createdAt: 1,
  })
  const backup = JSON.parse(
    JSON.stringify(
      await buildBackupPackage({
        includeSessions: true,
        includeApiKey: false,
        includeCoreData: false,
        includePlugins: false,
        includeSettings: false,
        includeLocalStorage: false,
      })
    )
  )
  expect(backup.payload.sessionAssets).toHaveLength(1)
  await applyBackupPackage(
    backup,
    { includeSessions: true, includeApiKey: false, mergeStrategy: "duplicate" },
    { storage: null, projectMcp: async () => [] }
  )
  const duplicate = (await getDb().sessions.toArray()).find((session) => session.id !== "source")!
  expect(duplicate).toBeDefined()
  const restored = await getSessionAsset(duplicate.id, asset.assetId)
  expect(restored?.contentHash).toBe(asset.contentHash)
  expect(await readBlobAsArrayBuffer(restored!.blob)).toEqual(await readBlobAsArrayBuffer(blob))
  expect(await getDb().messages.where("sessionId").equals(duplicate.id).count()).toBe(1)
  expect(await getDb().messageMedia.count()).toBe(1)
})

it("includes originals in streaming sections and excludes them without sessions", async () => {
  await seed()
  const chunks = []
  for await (const section of buildBackupSections(
    {
      includeSessions: true,
      includeApiKey: false,
      includeCoreData: false,
      includePlugins: false,
      includeSettings: false,
      includeLocalStorage: false,
    },
    { maxChunkBytes: 4096 }
  )) {
    if (section.section === "sessionAssetSourceChunks") chunks.push(...section.rows)
  }
  expect(chunks.length).toBeGreaterThan(4)
  const withoutSessions = await buildBackupPackage({ includeSessions: false, includeApiKey: false })
  expect(withoutSessions.payload.sessionAssets).toBeUndefined()
})

it("rejects incomplete source backup before making any session writes", async () => {
  await seed()
  const backup = await buildBackupPackage({ includeSessions: true, includeApiKey: false })
  backup.payload.sessionAssetSourceChunks = []
  await getDb().sessions.clear()
  await expect(
    applyBackupPackage(
      backup,
      { includeSessions: true, includeApiKey: false, mergeStrategy: "overwrite" },
      { storage: null }
    )
  ).rejects.toThrow("incomplete")
  expect(await getDb().sessions.count()).toBe(0)
})

it("round trips derived-only metadata and deletion tombstones without inventing original bytes", async () => {
  const { persistMessageSessionAssets, listSessionAssets, releaseSessionAsset } =
    await import("@/lib/db/session-assets")
  await seed()
  const content = {
    attachmentId: "remote",
    contentHash: "0".repeat(64),
    status: "ready" as const,
    processor: { id: "text", version: "1" },
    segments: [
      { id: "body", text: "Remote content", locator: { type: "text" as const, start: 0, end: 14 } },
    ],
  }
  const message = {
    id: "remote",
    role: "user",
    parts: [{ type: "text", text: "", extractedContent: content }],
  } as unknown as import("ai").UIMessage
  await persistMessageSessionAssets("source", message)
  await releaseSessionAsset("source", "a")
  const backup = await buildBackupPackage({ includeSessions: true, includeApiKey: false })
  expect(backup.payload.sessionAssets).toHaveLength(2)
  expect(backup.payload.sessionAssetSourceChunks).toBeUndefined()
  await getDb().messageMediaRefs.clear()
  await applyBackupPackage(
    backup,
    { includeSessions: true, includeApiKey: false, mergeStrategy: "overwrite" },
    { storage: null, projectMcp: async () => [] }
  )
  expect(await listSessionAssets("source")).toEqual([
    expect.objectContaining({ assetId: "remote", sourceAvailable: false }),
  ])
  expect(await getSessionAsset("source", "remote")).toBeUndefined()
  expect(await getSessionAsset("source", "a")).toBeUndefined()
})

it("round trips canonical video/image previews, thumbnails and image originals with regenerated owners", async () => {
  const { hashSessionAssetSource } = await import("@/lib/db/session-assets")
  const { putMessageMedia, mediaRef } = await import("@/lib/db/message-media")
  await seed()
  const blob = new Blob(["canonical preview"], { type: "image/jpeg" })
  const thumbBlob = new Blob(["small thumbnail"], { type: "image/webp" })
  const originalBlob = new Blob(["original image"], { type: "image/png" })
  // Ingest keys are source hashes; resizing can change the canonical byte hash.
  const hash = await hashSessionAssetSource(originalBlob)
  await putMessageMedia({
    hash,
    blob,
    thumbBlob,
    originalBlob,
    mediaType: blob.type,
    byteSize: blob.size,
    width: 1024,
    height: 512,
    thumbWidth: 128,
    thumbHeight: 64,
    originalByteSize: originalBlob.size,
    originalMediaType: originalBlob.type,
    createdAt: 1,
    lastUsedAt: 2,
  })
  await getDb().messages.put({
    id: "preview",
    sessionId: "source",
    role: "user",
    parts: [{ type: "file", mediaType: "image/jpeg", url: mediaRef(hash) }],
    createdAt: 1,
  })
  const backup = JSON.parse(
    JSON.stringify(await buildBackupPackage({ includeSessions: true, includeApiKey: false }))
  )
  expect(backup.payload.messageMedia).toHaveLength(1)
  expect(backup.payload.messageMediaChunks).toHaveLength(3)
  await getDb().messageMedia.clear()
  await getDb().messageMediaRefs.clear()
  await applyBackupPackage(
    backup,
    { includeSessions: true, includeApiKey: false, mergeStrategy: "duplicate" },
    { storage: null, projectMcp: async () => [] }
  )
  const restored = await getDb().messageMedia.get(hash)
  expect(await readBlobAsArrayBuffer(restored!.blob)).toEqual(await readBlobAsArrayBuffer(blob))
  expect(await readBlobAsArrayBuffer(restored!.thumbBlob!)).toEqual(
    await readBlobAsArrayBuffer(thumbBlob)
  )
  expect(restored!.thumbBlob!.type).toBe("image/webp")
  expect(await readBlobAsArrayBuffer(restored!.originalBlob!)).toEqual(
    await readBlobAsArrayBuffer(originalBlob)
  )
  expect(restored!.originalBlob!.type).toBe("image/png")
  const refs = await getDb().messageMediaRefs.where("hash").equals(hash).toArray()
  expect(refs).toHaveLength(1)
  expect(refs[0]!.sessionId).not.toBe("source")
  expect(await getDb().messages.get(refs[0]!.messageId)).toMatchObject({
    sessionId: refs[0]!.sessionId,
  })
})

describe("Files page backup (ADR-0200)", () => {
  const exportOptions = {
    includeSessions: false,
    includeApiKey: false,
    includePlugins: false,
    includeSettings: false,
    includeLocalStorage: false,
  }

  async function seedFiles() {
    const { putLibraryAsset } = await import("@/lib/db/session-assets")
    const { setLibraryItemFavorite } = await import("@/lib/db/files-library-items")
    const { createLibraryFolder } = await import("@/lib/db/files-library-folders")
    const { putMessageMedia, mediaRef } = await import("@/lib/db/message-media")
    const { asset: sessionAsset } = await seed()
    // An image kept after its conversation was deleted: referenced only by the pin.
    const image = new Blob(["kept image"], { type: "image/png" })
    const imageHash = "a".repeat(64)
    await putMessageMedia({
      hash: imageHash,
      blob: image,
      mediaType: "image/png",
      byteSize: image.size,
      width: 1,
      height: 1,
      createdAt: 1,
      lastUsedAt: 1,
    })
    await getDb().messages.put({
      id: "m",
      sessionId: "source",
      role: "user",
      parts: [{ type: "file", mediaType: "image/png", url: mediaRef(imageHash) }],
      createdAt: 1,
    })
    await getDb().messageMediaRefs.put({ messageId: "m", sessionId: "source", hash: imageHash })
    const folder = await createLibraryFolder({ name: "Specs" })
    await setLibraryItemFavorite(
      { kind: "image", sourceId: imageHash, mediaHash: imageHash, originSessionId: "source" },
      true
    )
    await setLibraryItemFavorite(
      {
        kind: "session-upload",
        sourceId: sessionAsset.contentHash,
        mediaHash: `original:${sessionAsset.contentHash}`,
        snapshot: { title: "report.pdf" },
      },
      true
    )
    await putLibraryAsset({
      assetId: "u1",
      blob: new Blob(["owned notes"]),
      filename: "notes.md",
      mediaType: "text/markdown",
    })
    const { setLibraryItemFolder } = await import("@/lib/db/files-library-items")
    await setLibraryItemFolder({ kind: "upload", sourceId: "u1" }, folder.id)
    return { imageHash, sessionAsset, folder }
  }

  async function wipeLocal() {
    const db = getDb()
    await db.sessions.clear()
    await db.messages.clear()
    await db.messageMediaRefs.clear()
    await db.messageMedia.clear()
    await db.libraryItems.clear()
    await db.libraryFolders.clear()
  }

  it("round trips kept images, kept uploads, Files uploads and folders without transcripts", async () => {
    const { imageHash, sessionAsset, folder } = await seedFiles()
    const backup = JSON.parse(JSON.stringify(await buildBackupPackage(exportOptions)))
    expect(backup.payload.sessions).toBeUndefined()
    expect(backup.payload.libraryItems).toHaveLength(3)
    expect(backup.payload.libraryFolders).toHaveLength(1)
    expect(backup.payload.libraryAssets).toHaveLength(1)
    const exportedHashes = backup.payload.messageMedia.map((row: { hash: string }) => row.hash)
    expect(exportedHashes).toHaveLength(3)
    expect(exportedHashes).toEqual(
      expect.arrayContaining([imageHash, `original:${sessionAsset.contentHash}`])
    )

    await wipeLocal()
    await applyBackupPackage(
      backup,
      { includeSessions: false, includeApiKey: false, mergeStrategy: "skip" },
      { storage: null, projectMcp: async () => [] }
    )

    const db = getDb()
    expect(await db.libraryFolders.get(folder.id)).toMatchObject({ name: "Specs" })
    expect((await db.libraryItems.get("upload:u1"))?.folderId).toBe(folder.id)
    const { getLibraryAsset, getHeldSessionAssetSource } = await import("@/lib/db/session-assets")
    expect(await (await getLibraryAsset("u1"))!.blob.text()).toBe("owned notes")
    expect(await getHeldSessionAssetSource(sessionAsset.contentHash)).toBeInstanceOf(Blob)
    expect(await (await db.messageMedia.get(imageHash))!.blob.text()).toBe("kept image")
    // Pins rebuilt from the items: nothing restored is collectable.
    const pins = await db.messageMediaRefs.where("sessionId").equals("library:files").toArray()
    expect(pins).toHaveLength(3)
    expect(pins.map((ref) => ref.hash)).toEqual(
      expect.arrayContaining([imageHash, `original:${sessionAsset.contentHash}`])
    )
    const { collectUnreferencedMessageMedia } = await import("@/lib/db/message-media-refs")
    await collectUnreferencedMessageMedia(undefined, { graceMs: 0 })
    expect(await db.messageMedia.count()).toBe(3)
  })

  it("streams the Files sections and their bytes once", async () => {
    await seedFiles()
    const seen: Record<string, number> = {}
    const chunkHashes: string[] = []
    for await (const section of buildBackupSections(exportOptions)) {
      seen[section.section] = (seen[section.section] ?? 0) + section.rows.length
      if (section.section === "messageMediaChunks")
        chunkHashes.push(
          ...(section.rows as Array<{ contentHash: string; offset: number }>)
            .filter((r) => r.offset === 0)
            .map((r) => r.contentHash)
        )
    }
    expect(seen).toMatchObject({
      libraryItems: 3,
      libraryFolders: 1,
      libraryAssets: 1,
      messageMedia: 3,
    })
    expect(new Set(chunkHashes).size).toBe(chunkHashes.length)
  })

  it("ignores transcript media it is not importing instead of refusing the package", async () => {
    await seedFiles()
    const backup = JSON.parse(
      JSON.stringify(await buildBackupPackage({ ...exportOptions, includeSessions: true }))
    )
    await wipeLocal()
    await expect(
      applyBackupPackage(
        backup,
        { includeSessions: false, includeApiKey: false, mergeStrategy: "overwrite" },
        { storage: null, projectMcp: async () => [] }
      )
    ).resolves.toBeDefined()
    expect(await getDb().sessions.count()).toBe(0)
    expect(await getDb().libraryItems.count()).toBe(3)
  })

  it("refuses a Files upload whose bytes are not in the package", async () => {
    await seedFiles()
    const backup = JSON.parse(JSON.stringify(await buildBackupPackage(exportOptions)))
    backup.payload.messageMedia = backup.payload.messageMedia.filter(
      (row: { hash: string }) =>
        row.hash !== `original:${backup.payload.libraryAssets[0].contentHash}`
    )
    backup.payload.messageMediaChunks = []
    backup.payload.messageMedia = []
    await wipeLocal()
    await expect(
      applyBackupPackage(
        backup,
        { includeSessions: false, includeApiKey: false, mergeStrategy: "skip" },
        { storage: null, projectMcp: async () => [] }
      )
    ).rejects.toThrow("library_asset_backup_source_missing")
    expect(await getDb().libraryItems.count()).toBe(0)
  })
})
