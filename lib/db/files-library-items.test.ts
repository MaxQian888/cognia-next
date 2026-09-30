import type { ChatSession } from "@cognia/agent-config-types"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"
import {
  clearLibraryData,
  deleteLibraryItemsForProject,
  deleteOwnedLibraryItem,
  getLibraryItem,
  hideLibraryItem,
  LibraryItemError,
  libraryPinOwner,
  listKeptSourceIdsForSession,
  listLibraryItems,
  preserveGeneratedVideoRecords,
  reconcileLibraryPins,
  setLibraryItemFavorite,
  setLibraryItemFolder,
  touchLibraryItemOpened,
} from "./files-library-items"
import { createLibraryFolder } from "./files-library-folders"
import { ROOT_LIBRARY_FOLDER_ID } from "./files-library-types"
import { LIBRARY_REF_SESSION_ID } from "./message-media-refs"
import { putLibraryAsset, putSessionAsset } from "./session-assets"
import type { MediaGenerationJobRow } from "@/lib/ai/media/video-jobs/types"
import { bulkDeleteSessions } from "./sessions"
import type { MessageMediaRow } from "./message-media"

jest.setTimeout(30_000)
const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(async () => {
  await fixture.restore()
  await getDb().sessions.bulkPut(
    ["s1", "s2"].map((id) => ({ id, title: id, createdAt: 1, updatedAt: 1 }) as ChatSession)
  )
})
afterAll(fixture.dispose)

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

const image = { kind: "image" as const, sourceId: "h1", originSessionId: "s1", mediaHash: "h1" }

async function pins() {
  return getDb().messageMediaRefs.where("sessionId").equals(LIBRARY_REF_SESSION_ID).toArray()
}

describe("keep state and pins", () => {
  beforeEach(async () => {
    await getDb().messageMedia.put(media("h1"))
    await getDb().messageMediaRefs.put({ messageId: "m1", sessionId: "s1", hash: "h1" })
  })

  it("records an open without keeping or pinning", async () => {
    const row = await touchLibraryItemOpened(image)
    expect(row.lastOpenedAt).toEqual(expect.any(Number))
    expect(row.keptAt).toBeUndefined()
    expect(await pins()).toEqual([])
  })

  it("pins on favorite and releases the pin on unfavorite", async () => {
    const kept = await setLibraryItemFavorite(image, true)
    expect(kept.favoritedAt).toEqual(expect.any(Number))
    expect(kept.keptAt).toEqual(expect.any(Number))
    expect(await pins()).toEqual([
      { messageId: libraryPinOwner("image:h1"), sessionId: LIBRARY_REF_SESSION_ID, hash: "h1" },
    ])

    const released = await setLibraryItemFavorite(image, false)
    expect(released.favoritedAt).toBeUndefined()
    expect(released.keptAt).toBeUndefined()
    expect(await pins()).toEqual([])
    // The message still references the bytes, so they stay.
    expect(await getDb().messageMedia.get("h1")).toBeDefined()
  })

  it("keeps a pinned image alive through deletion of its conversation", async () => {
    await setLibraryItemFavorite(image, true)
    await bulkDeleteSessions(["s1"])
    expect(await getDb().messageMedia.get("h1")).toBeDefined()
    expect(await getLibraryItem("image:h1")).toMatchObject({ originSessionId: "s1" })
  })

  it("refuses to keep an item whose bytes are gone", async () => {
    await expect(
      setLibraryItemFavorite({ kind: "image", sourceId: "gone", mediaHash: "gone" }, true)
    ).rejects.toMatchObject({ code: "library_item_source_missing" })
    expect(await getLibraryItem("image:gone")).toBeUndefined()
  })

  it("files into a folder and back out, bringing a hidden item back", async () => {
    await hideLibraryItem(image)
    expect((await getLibraryItem("image:h1"))?.hiddenAt).toEqual(expect.any(Number))
    const folder = await createLibraryFolder({ name: "Specs" })
    const filed = await setLibraryItemFolder(image, folder.id)
    expect(filed).toMatchObject({ folderId: folder.id })
    expect(filed.hiddenAt).toBeUndefined()
    expect(await pins()).toHaveLength(1)
    const unfiled = await setLibraryItemFolder(image, null)
    expect(unfiled.folderId).toBeUndefined()
    expect(await pins()).toEqual([])
  })

  it("rejects filing into a folder that does not exist, but accepts the root", async () => {
    await expect(setLibraryItemFolder(image, "lbf_missing")).rejects.toBeInstanceOf(
      LibraryItemError
    )
    await expect(setLibraryItemFolder(image, ROOT_LIBRARY_FOLDER_ID)).resolves.toMatchObject({
      folderId: ROOT_LIBRARY_FOLDER_ID,
    })
  })

  it("hide drops the favorite and the pin but leaves the source", async () => {
    await setLibraryItemFavorite(image, true)
    const hidden = await hideLibraryItem(image)
    expect(hidden.favoritedAt).toBeUndefined()
    expect(hidden.hiddenAt).toEqual(expect.any(Number))
    expect(await pins()).toEqual([])
    expect(await getDb().messageMedia.get("h1")).toBeDefined()
  })
})

describe("Files-owned items", () => {
  it("refuses to hide a Files-owned upload and deletes it with its bytes", async () => {
    await putLibraryAsset({
      assetId: "u1",
      blob: new Blob(["spec body"], { type: "text/markdown" }),
      filename: "SPEC.md",
      mediaType: "text/markdown",
      projectId: "p1",
    })
    const row = await getLibraryItem("upload:u1")
    expect(row).toMatchObject({ ownedByFiles: true, projectId: "p1", kind: "upload" })
    await expect(hideLibraryItem({ kind: "upload", sourceId: "u1" })).rejects.toMatchObject({
      code: "library_item_owned",
    })
    await deleteOwnedLibraryItem("upload:u1")
    expect(await getLibraryItem("upload:u1")).toBeUndefined()
    expect(await getDb().messageMedia.count()).toBe(0)
  })

  it("refuses to delete an item Files does not own", async () => {
    await getDb().messageMedia.put(media("h1"))
    await setLibraryItemFavorite(image, true)
    await expect(deleteOwnedLibraryItem("image:h1")).rejects.toMatchObject({
      code: "library_item_not_owned",
    })
    await expect(deleteOwnedLibraryItem("image:missing")).resolves.toBeUndefined()
  })
})

describe("session purge support", () => {
  it("lists kept artifact and canvas ids of a conversation only", async () => {
    await setLibraryItemFavorite({ kind: "artifact", sourceId: "a1", originSessionId: "s1" }, true)
    await setLibraryItemFavorite({ kind: "canvas", sourceId: "c1", originSessionId: "s1" }, true)
    await touchLibraryItemOpened({ kind: "artifact", sourceId: "a2", originSessionId: "s1" })
    await setLibraryItemFavorite({ kind: "artifact", sourceId: "a3", originSessionId: "s2" }, true)
    const kept = await listKeptSourceIdsForSession("s1")
    expect([...kept.artifactIds]).toEqual(["a1"])
    expect([...kept.canvasIds]).toEqual(["c1"])
  })
})

describe("generated video records outliving their conversation", () => {
  const video = () => new Blob([new Uint8Array([7, 7, 7])], { type: "video/mp4" })

  function succeeded(id: string, sessionId: string, assetId: string): MediaGenerationJobRow {
    return {
      id,
      kind: "video",
      sessionId,
      origin: { surface: "chat-tool", sessionId },
      request: { prompt: "a boat at dawn" },
      provider: { providerId: "google", modelId: "veo-3", credentialAffinity: "keyless" },
      operation: {},
      status: "succeeded",
      pollCount: 1,
      nextPollAt: 0,
      deadlineAt: 0,
      createdAt: 1,
      updatedAt: 1,
      settledAt: 2,
      result: {
        content: { kind: "session-asset", sessionId, assetId },
        mediaType: "video/mp4",
        byteSize: 3,
        durationSec: 8,
        width: 1280,
        height: 720,
      },
    }
  }

  const record = {
    jobId: "vjob_1",
    prompt: "a boat at dawn",
    providerId: "google",
    modelId: "veo-3",
    durationSec: 8,
    width: 1280,
    height: 720,
  }

  async function generatedInChat() {
    const asset = await putSessionAsset({
      sessionId: "s1",
      assetId: "video-vjob_1",
      filename: "a boat at dawn.mp4",
      mediaType: "video/mp4",
      blob: video(),
    })
    await getDb().mediaGenerationJobs.put(succeeded("vjob_1", "s1", "video-vjob_1"))
    return asset.contentHash
  }

  it("copies the record onto the kept upload and a Files upload of the same bytes", async () => {
    const contentHash = await generatedInChat()
    const kept = await setLibraryItemFavorite(
      {
        kind: "session-upload",
        sourceId: contentHash,
        originSessionId: "s1",
        mediaHash: `original:${contentHash}`,
        snapshot: { title: "a boat at dawn.mp4", mediaType: "video/mp4" },
      },
      true
    )
    await putLibraryAsset({
      assetId: "own",
      blob: video(),
      filename: "boat.mp4",
      mediaType: "video/mp4",
    })
    const ownedBefore = await getLibraryItem("upload:own")

    await bulkDeleteSessions(["s1"])

    const keptAfter = await getLibraryItem(kept.key)
    expect(keptAfter?.snapshot?.generated).toEqual(record)
    // A copy the user did not make leaves the item's own timestamps alone.
    expect(keptAfter?.updatedAt).toBe(kept.updatedAt)
    const ownedAfter = await getLibraryItem("upload:own")
    expect(ownedAfter?.snapshot).toEqual({ ...ownedBefore!.snapshot, generated: record })
    expect(await getDb().mediaGenerationJobs.count()).toBe(0)
  })

  it("keeps a copy taken when the item was kept", async () => {
    const contentHash = await generatedInChat()
    const earlier = { ...record, prompt: "copied at keep time" }
    await setLibraryItemFavorite(
      {
        kind: "session-upload",
        sourceId: contentHash,
        mediaHash: `original:${contentHash}`,
        snapshot: { title: "t", generated: earlier },
      },
      true
    )
    const db = getDb()
    await expect(
      db.transaction("rw", [db.libraryItems, db.messageMediaRefs, db.mediaGenerationJobs], () =>
        preserveGeneratedVideoRecords(db, ["s1"])
      )
    ).resolves.toBe(0)
    expect((await getLibraryItem(`session-upload:${contentHash}`))?.snapshot?.generated).toEqual(
      earlier
    )
  })

  it("does nothing for a conversation with no finished video, or an item not in Files", async () => {
    const db = getDb()
    const run = (ids: string[]) =>
      db.transaction("rw", [db.libraryItems, db.messageMediaRefs, db.mediaGenerationJobs], () =>
        preserveGeneratedVideoRecords(db, ids)
      )
    await expect(run([])).resolves.toBe(0)
    await generatedInChat()
    await expect(run(["s2"])).resolves.toBe(0)
    await expect(run(["s1"])).resolves.toBe(0)
    await getDb().mediaGenerationJobs.put({ ...succeeded("vjob_1", "s1", "gone"), id: "vjob_2" })
    await expect(run(["s1"])).resolves.toBe(0)
  })
})

describe("reconcileLibraryPins", () => {
  it("adds missing pins and removes stray ones", async () => {
    const db = getDb()
    await db.messageMedia.bulkPut([media("h1"), media("h2", Date.now())])
    await db.libraryItems.bulkPut([
      {
        key: "image:h1",
        kind: "image",
        sourceId: "h1",
        mediaHash: "h1",
        favoritedAt: 1,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        key: "image:h9",
        kind: "image",
        sourceId: "h9",
        mediaHash: "h9",
        favoritedAt: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    ])
    await db.messageMediaRefs.put({
      messageId: libraryPinOwner("image:h2"),
      sessionId: LIBRARY_REF_SESSION_ID,
      hash: "h2",
    })
    await expect(reconcileLibraryPins()).resolves.toEqual({ added: 1, removed: 1 })
    expect((await pins()).map((ref) => ref.hash)).toEqual(["h1"])
  })
})

describe("project cascade and full clear", () => {
  it("deletes a project's items, pins and Files-owned bytes", async () => {
    const db = getDb()
    await db.messageMedia.put(media("h1"))
    await setLibraryItemFavorite({ ...image, projectId: "p1" }, true)
    await putLibraryAsset({
      assetId: "u1",
      blob: new Blob(["x"], { type: "text/plain" }),
      filename: "x.txt",
      mediaType: "text/plain",
      projectId: "p1",
    })
    await setLibraryItemFavorite({ kind: "artifact", sourceId: "a1", projectId: "p2" }, true)
    await expect(deleteLibraryItemsForProject("p1")).resolves.toBe(2)
    expect((await listLibraryItems()).map((row) => row.key)).toEqual(["artifact:a1"])
    expect(await pins()).toEqual([])
    expect(await db.messageMedia.get("h1")).toBeUndefined()
  })

  it("clears both tables and every library ref", async () => {
    await createLibraryFolder({ name: "F" })
    await putLibraryAsset({
      assetId: "u1",
      blob: new Blob(["x"], { type: "text/plain" }),
      filename: "x.txt",
      mediaType: "text/plain",
    })
    await clearLibraryData()
    expect(await getDb().libraryItems.count()).toBe(0)
    expect(await getDb().libraryFolders.count()).toBe(0)
    expect(await pins()).toEqual([])
  })
})
