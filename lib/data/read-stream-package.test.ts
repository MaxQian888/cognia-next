import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { putSessionAsset, getSessionAsset } from "@/lib/db/session-assets"
import { readBlobAsArrayBuffer } from "@cognia/ocr/blob-utils"
import { buildBackupStream, buildBackupSections } from "./build-stream"
import { buildBackupPackage, BackupRequiresStreamError } from "./build-package"
import { readStreamPackage } from "./read-stream-package"
import { createBackupStream, type BackupStreamSection } from "./stream-format"
import { applyBackupPackage } from "./apply-package"
import type { ChatSession } from "@cognia/agent-config-types"

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)

it("sessions-only streaming never exports a new session whose organizational parents were not emitted", async () => {
  const sections: BackupStreamSection[] = []
  for await (const section of buildBackupSections(
    { includeSessions: true, includeApiKey: false, includeCoreData: false },
    { storage: null }
  )) {
    sections.push(section)
    if (section.section === "sessionFolders") {
      const date = new Date("2026-10-21T00:00:00.000Z")
      await getDb().table("projects").put({
        id: "late-project",
        name: "Late",
        roots: [],
        knowledgeBase: [],
        sessionIds: [],
        sessionCount: 0,
        messageCount: 0,
        createdAt: date,
        updatedAt: date,
        lastAccessedAt: date,
      })
      await getDb().sessionFolders.put({
        id: "late-folder",
        projectId: "late-project",
        name: "Late",
        order: 0,
        createdAt: 1,
        updatedAt: 1,
      })
      await getDb().sessions.put({
        id: "late-organized",
        kind: "direct",
        title: "Late",
        projectId: "late-project",
        folderId: "late-folder",
        createdAt: 1,
        updatedAt: 1,
      })
    }
  }
  const restored = await readStreamPackage(
    createBackupStream({
      manifest: {
        traceId: "late-parents",
        exportedAt: "2026-10-21T00:00:00.000Z",
        appVersion: "test",
        backend: "web-dexie",
        sourceSchemaVersion: getDb().verno,
      },
      sections: (async function* () {
        yield* sections
      })(),
    })
  )
  const late = restored.pkg.payload.sessions?.find((session) => session.id === "late-organized")
  expect(late).toBeDefined()
  expect(late?.projectId).toBeUndefined()
  expect(late?.folderId).toBeUndefined()
})

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

test("excludes messages created after their parent session section was exported", async () => {
  const db = getDb()
  await db.sessions.put({
    id: "before",
    title: "Existing session",
    kind: "direct",
    createdAt: 1,
    updatedAt: 1,
  })
  let inserted = false
  async function* interleavedSections(): AsyncIterable<BackupStreamSection> {
    for await (const section of buildBackupSections({
      includeSessions: true,
      includeApiKey: false,
      includeCoreData: false,
      includeSettings: false,
      includePlugins: false,
      includeLocalStorage: false,
    })) {
      yield section
      if (section.section === "sessions" && !inserted) {
        inserted = true
        // Models normal user writes while the exporter waits for its next section.
        await db.sessions.put({
          id: "late",
          title: "Created during backup",
          kind: "direct",
          createdAt: 2,
          updatedAt: 2,
        })
        await db.messages.put({
          id: "late-message",
          sessionId: "late",
          role: "user",
          parts: [{ type: "text", text: "Typed during backup" }],
          createdAt: 2,
        })
      }
    }
  }
  const restored = await readStreamPackage(
    createBackupStream({
      manifest: {
        traceId: "concurrent-audit",
        exportedAt: "2026-10-21T00:00:00.000Z",
        appVersion: "audit",
        backend: "web-dexie",
        sourceSchemaVersion: db.verno,
      },
      sections: interleavedSections(),
    })
  )
  expect(restored.pkg.payload.sessions?.map((row) => row.id)).toEqual(["before"])
  expect(restored.pkg.payload.messages ?? []).toEqual([])
  await db.messages.clear()
  await db.sessions.clear()
  await applyBackupPackage(
    restored.pkg,
    { mergeStrategy: "overwrite", includeSessions: true, includeApiKey: false },
    { ...restored.extras, storage: null, projectMcp: async () => [] }
  )
  expect(await db.messages.get("late-message")).toBeUndefined()
  expect(await db.sessions.get("late")).toBeUndefined()
})
