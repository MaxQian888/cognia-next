import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { putSessionAsset, getSessionAsset } from "@/lib/db/session-assets"
import { readBlobAsArrayBuffer } from "@cognia/ocr/blob-utils"
import { buildBackupStream } from "./build-stream"
import { buildBackupPackage, BackupRequiresStreamError } from "./build-package"
import { readStreamPackage } from "./read-stream-package"
import { createBackupStream } from "./stream-format"
import { applyBackupPackage } from "./apply-package"
import type { ChatSession } from "@cognia/agent-config-types"

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)

it("restores encrypted stream metadata and binary attachments through the atomic package importer", async () => {
  await getDb().sessions.put({
    id: "stream-session",
    title: "Attachments",
    createdAt: 1,
    updatedAt: 1,
  } as ChatSession)
  const original = new Blob([new Uint8Array(170000).fill(61)], { type: "application/pdf" })
  const asset = await putSessionAsset({
    sessionId: "stream-session",
    assetId: "source",
    filename: "original.pdf",
    mediaType: original.type,
    blob: original,
  })
  const restored = await readStreamPackage(
    buildBackupStream(
      { includeSessions: true, includeApiKey: false },
      {
        encryption: { passphrase: "portable" },
        storage: null,
        profileDekStore: {
          listProfileIds: async () => [],
          exportPortable: async () => {
            throw new Error("unexpected key")
          },
        },
      }
    ),
    "portable"
  )
  expect(restored.pkg.payload.sessionAssets).toHaveLength(1)
  expect(restored.pkg.payload.sessionAssetSourceChunks).toBeUndefined()
  expect(restored.extras.attachmentSources?.get(asset.contentHash)?.size).toBe(original.size)
  await getDb().messageMediaRefs.clear()
  await getDb().messageMedia.clear()
  await getDb().sessions.clear()
  await applyBackupPackage(
    restored.pkg,
    {
      mergeStrategy: "overwrite",
      includeSessions: true,
      includeApiKey: false,
      retrievalDekPassphrase: "portable",
    },
    { ...restored.extras, storage: null }
  )
  const saved = await getSessionAsset("stream-session", "source")
  expect(saved?.blob.type).toBe(original.type)
  expect(await readBlobAsArrayBuffer(saved!.blob)).toEqual(await readBlobAsArrayBuffer(original))
})

it("carries every populated legacy package section through the streaming adapter", async () => {
  await getDb().canvasComments.put({
    id: "legacy-comment",
    documentId: "doc",
    body: "preserve",
    createdAt: 1,
  } as never)
  const opts = { includeSessions: true, includeApiKey: false }
  const legacy = await buildBackupPackage(opts, { storage: null })
  const streamed = await readStreamPackage(buildBackupStream(opts, { storage: null }))
  for (const [key, value] of Object.entries(legacy.payload)) {
    if (value === undefined || (Array.isArray(value) && value.length === 0)) continue
    expect(streamed.pkg.payload).toHaveProperty(key)
  }
  expect(streamed.pkg.payload.providerProfileStore).toEqual(legacy.payload.providerProfileStore)
  expect(streamed.pkg.payload.canvasComments).toEqual([
    expect.objectContaining({ id: "legacy-comment" }),
  ])
})

it("rejects unknown sections and a missing authenticated footer before returning a preview", async () => {
  const manifest = {
    traceId: "invalid",
    exportedAt: "2026-09-21T00:00:00Z",
    appVersion: "test",
    backend: "web-dexie" as const,
    sourceSchemaVersion: 3,
  }
  await expect(
    readStreamPackage(
      createBackupStream({
        manifest,
        sections: (async function* () {
          yield { section: "futureDomain", rows: [{ id: "keep" }] }
        })(),
      })
    )
  ).rejects.toThrow("Unsupported backup section")
  const records: Uint8Array[] = []
  for await (const bytes of createBackupStream({
    manifest,
    sections: (async function* () {
      yield { section: "messages", rows: [] }
    })(),
  }))
    records.push(bytes)
  await expect(
    readStreamPackage(
      (async function* () {
        yield* records.slice(0, -1)
      })()
    )
  ).rejects.toThrow("footer")
})

it("rejects oversized sources in string-only share and remote packages before reading their bytes", async () => {
  await getDb().sessions.put({
    id: "large",
    title: "Large",
    createdAt: 1,
    updatedAt: 1,
  } as ChatSession)
  await getDb().messageMediaRefs.put({
    messageId: "session-asset:large",
    hash: "original:large",
    sessionId: "large",
    sessionAsset: {
      sessionId: "large",
      assetId: "original",
      contentHash: "a".repeat(64),
      filename: "large.mp4",
      mediaType: "video/mp4",
      byteSize: 500 * 1024 * 1024,
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
      temporary: false,
    },
  })
  await expect(
    buildBackupPackage({ includeSessions: true, includeApiKey: false })
  ).rejects.toBeInstanceOf(BackupRequiresStreamError)
})
