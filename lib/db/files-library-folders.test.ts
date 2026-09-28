import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"
import {
  createLibraryFolder,
  deleteLibraryFolder,
  getLibraryFolder,
  getLibraryFolderDescendantIds,
  getLibraryFolderPath,
  listChildLibraryFolders,
  listLibraryFolders,
  moveLibraryFolder,
  renameLibraryFolder,
  updateLibraryFolder,
} from "./files-library-folders"
import {
  getLibraryItem,
  libraryPinOwner,
  setLibraryItemFavorite,
  setLibraryItemFolder,
} from "./files-library-items"
import { ROOT_LIBRARY_FOLDER_ID } from "./files-library-types"
import type { MessageMediaRow } from "./message-media"

jest.setTimeout(30_000)
const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)

function media(hash: string): MessageMediaRow {
  return {
    hash,
    mediaType: "image/png",
    width: 1,
    height: 1,
    blob: new Blob([hash]),
    byteSize: 1,
    createdAt: 1,
    lastUsedAt: 1,
  }
}

describe("folder CRUD", () => {
  it("creates at the root with a trimmed name and rejects an empty name", async () => {
    const folder = await createLibraryFolder({ name: "  Specs  ", color: "blue" })
    expect(folder).toMatchObject({
      name: "Specs",
      parentFolderId: ROOT_LIBRARY_FOLDER_ID,
      color: "blue",
    })
    expect(folder.id).toMatch(/^lbf_/)
    await expect(createLibraryFolder({ name: "   " })).rejects.toMatchObject({
      code: "library_folder_name_required",
    })
    await expect(
      createLibraryFolder({ name: "x", parentFolderId: "lbf_missing" })
    ).rejects.toMatchObject({
      code: "library_folder_parent_missing",
    })
  })

  it("lists, renames and updates", async () => {
    const b = await createLibraryFolder({ name: "Bravo" })
    const a = await createLibraryFolder({ name: "Alpha" })
    const child = await createLibraryFolder({ name: "Child", parentFolderId: a.id })
    expect((await listLibraryFolders()).map((f) => f.name)).toEqual(["Alpha", "Bravo", "Child"])
    expect((await listChildLibraryFolders(ROOT_LIBRARY_FOLDER_ID)).map((f) => f.id)).toEqual([
      a.id,
      b.id,
    ])
    await renameLibraryFolder(b.id, " Beta ")
    expect((await getLibraryFolder(b.id))?.name).toBe("Beta")
    await expect(renameLibraryFolder(b.id, "")).rejects.toMatchObject({
      code: "library_folder_name_required",
    })
    await updateLibraryFolder(child.id, { icon: "star" })
    expect((await getLibraryFolder(child.id))?.icon).toBe("star")
  })

  it("moves with cycle guards and walks paths", async () => {
    const a = await createLibraryFolder({ name: "A" })
    const b = await createLibraryFolder({ name: "B", parentFolderId: a.id })
    const c = await createLibraryFolder({ name: "C", parentFolderId: b.id })
    expect((await getLibraryFolderPath(c.id)).map((f) => f.name)).toEqual(["A", "B", "C"])
    expect(await getLibraryFolderPath(ROOT_LIBRARY_FOLDER_ID)).toEqual([])
    expect([...(await getLibraryFolderDescendantIds(a.id))].sort()).toEqual([b.id, c.id].sort())
    await expect(moveLibraryFolder(a.id, a.id)).rejects.toMatchObject({
      code: "library_folder_cycle",
    })
    await expect(moveLibraryFolder(a.id, c.id)).rejects.toMatchObject({
      code: "library_folder_cycle",
    })
    await moveLibraryFolder(c.id, ROOT_LIBRARY_FOLDER_ID)
    expect((await getLibraryFolder(c.id))?.parentFolderId).toBe(ROOT_LIBRARY_FOLDER_ID)
  })
})

describe("deleteLibraryFolder", () => {
  const item = { kind: "image" as const, sourceId: "h1", mediaHash: "h1" }

  beforeEach(async () => {
    await getDb().messageMedia.put(media("h1"))
  })

  it("reparent lifts children and items one level and keeps them kept", async () => {
    const parent = await createLibraryFolder({ name: "Parent" })
    const doomed = await createLibraryFolder({ name: "Doomed", parentFolderId: parent.id })
    const nested = await createLibraryFolder({ name: "Nested", parentFolderId: doomed.id })
    await setLibraryItemFolder(item, doomed.id)
    await deleteLibraryFolder(doomed.id)
    expect(await getLibraryFolder(doomed.id)).toBeUndefined()
    expect((await getLibraryFolder(nested.id))?.parentFolderId).toBe(parent.id)
    expect((await getLibraryItem("image:h1"))?.folderId).toBe(parent.id)

    await deleteLibraryFolder(parent.id)
    expect((await getLibraryItem("image:h1"))?.folderId).toBe(ROOT_LIBRARY_FOLDER_ID)
    expect(
      await getDb().messageMediaRefs.where("messageId").equals(libraryPinOwner("image:h1")).count()
    ).toBe(1)
  })

  it("cascade removes the subtree, unfiles items and drops pins only for items kept by folder alone", async () => {
    const top = await createLibraryFolder({ name: "Top" })
    const inner = await createLibraryFolder({ name: "Inner", parentFolderId: top.id })
    await getDb().messageMedia.put(media("h2"))
    await setLibraryItemFolder(item, inner.id)
    const favorite = { kind: "image" as const, sourceId: "h2", mediaHash: "h2" }
    await setLibraryItemFolder(favorite, top.id)
    await setLibraryItemFavorite(favorite, true)

    await deleteLibraryFolder(top.id, "cascade")
    expect(await getDb().libraryFolders.count()).toBe(0)
    const plain = await getLibraryItem("image:h1")
    expect(plain?.folderId).toBeUndefined()
    expect(plain?.keptAt).toBeUndefined()
    expect(
      await getDb().messageMediaRefs.where("messageId").equals(libraryPinOwner("image:h1")).count()
    ).toBe(0)
    expect(
      await getDb().messageMediaRefs.where("messageId").equals(libraryPinOwner("image:h2")).count()
    ).toBe(1)
  })

  it("ignores a missing folder", async () => {
    await expect(deleteLibraryFolder("lbf_missing", "cascade")).resolves.toBeUndefined()
  })
})
