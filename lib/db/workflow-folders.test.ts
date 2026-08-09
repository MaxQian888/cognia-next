// CRUD + tree-helper coverage for workflow library folders: create/list/
// rename/update/move (with cycle guards) / delete (reparent + cascade) and
// the getFolderPath / getDescendantFolderIds walkers.

import {
  createFolder,
  deleteFolder,
  getDescendantFolderIds,
  getFolder,
  getFolderPath,
  listChildFolders,
  listFolders,
  moveFolder,
  renameFolder,
  updateFolder,
} from "./workflow-folders"
import { createWorkflow, listWorkflowsInFolder, moveWorkflowToFolder } from "./workflows"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"
import { ROOT_FOLDER_ID } from "@/types/workflow/folder"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().workflows.clear()
  await getDb().workflowFolders.clear()
})
afterAll(dbFixture.dispose)

describe("createFolder", () => {
  it("inserts a row with root default and trims the name", async () => {
    const f = await createFolder({ name: "  Reports  " })
    expect(f.id).toMatch(/^wff_/)
    expect(f.name).toBe("Reports")
    expect(f.parentFolderId).toBe(ROOT_FOLDER_ID)
    expect(f.createdAt).toBe(f.updatedAt)
  })

  it("falls back to 'Untitled folder' on empty name and honors parent/color/icon", async () => {
    const parent = await createFolder({ name: "Parent" })
    const child = await createFolder({
      name: "   ",
      parentFolderId: parent.id,
      color: "blue",
      icon: "star",
    })
    expect(child.name).toBe("Untitled folder")
    expect(child.parentFolderId).toBe(parent.id)
    expect(child.color).toBe("blue")
    expect(child.icon).toBe("star")
  })
})

describe("listFolders / listChildFolders", () => {
  it("listFolders returns every folder ordered by name", async () => {
    await createFolder({ name: "Charlie" })
    await createFolder({ name: "Alpha" })
    await createFolder({ name: "Bravo" })
    const names = (await listFolders()).map((f) => f.name)
    expect(names).toEqual(["Alpha", "Bravo", "Charlie"])
  })

  it("listChildFolders returns only direct children sorted by name", async () => {
    const parent = await createFolder({ name: "Parent" })
    await createFolder({ name: "Zeta", parentFolderId: parent.id })
    await createFolder({ name: "Beta", parentFolderId: parent.id })
    await createFolder({ name: "RootSibling" })
    const children = await listChildFolders(parent.id)
    expect(children.map((f) => f.name)).toEqual(["Beta", "Zeta"])
    const roots = await listChildFolders(ROOT_FOLDER_ID)
    expect(roots.map((f) => f.name)).toEqual(["Parent", "RootSibling"])
  })
})

describe("renameFolder / updateFolder", () => {
  it("renameFolder trims and bumps updatedAt", async () => {
    const f = await createFolder({ name: "Old" })
    const before = f.updatedAt
    await new Promise((r) => setTimeout(r, 5))
    await renameFolder(f.id, "  New  ")
    const fresh = await getFolder(f.id)
    expect(fresh?.name).toBe("New")
    expect(fresh?.updatedAt).toBeGreaterThan(before)
  })

  it("updateFolder merges a patch", async () => {
    const f = await createFolder({ name: "F" })
    await updateFolder(f.id, { color: "green" })
    expect((await getFolder(f.id))?.color).toBe("green")
  })
})

describe("moveFolder", () => {
  it("re-parents a folder", async () => {
    const a = await createFolder({ name: "A" })
    const b = await createFolder({ name: "B" })
    await moveFolder(b.id, a.id)
    expect((await getFolder(b.id))?.parentFolderId).toBe(a.id)
  })

  it("rejects moving a folder into itself", async () => {
    const a = await createFolder({ name: "A" })
    await expect(moveFolder(a.id, a.id)).rejects.toThrow(/itself/)
  })

  it("rejects moving a folder into one of its own descendants", async () => {
    const a = await createFolder({ name: "A" })
    const b = await createFolder({ name: "B", parentFolderId: a.id })
    const c = await createFolder({ name: "C", parentFolderId: b.id })
    await expect(moveFolder(a.id, c.id)).rejects.toThrow(/subfolder/)
  })

  it("allows moving back to root", async () => {
    const a = await createFolder({ name: "A" })
    const b = await createFolder({ name: "B", parentFolderId: a.id })
    await moveFolder(b.id, ROOT_FOLDER_ID)
    expect((await getFolder(b.id))?.parentFolderId).toBe(ROOT_FOLDER_ID)
  })
})

describe("deleteFolder", () => {
  it("reparent mode lifts child folders and workflows up to the parent", async () => {
    const parent = await createFolder({ name: "Parent" })
    const mid = await createFolder({ name: "Mid", parentFolderId: parent.id })
    const child = await createFolder({ name: "Child", parentFolderId: mid.id })
    const wf = await createWorkflow({ name: "WF" })
    await moveWorkflowToFolder(wf.id, mid.id)

    await deleteFolder(mid.id, "reparent")

    expect(await getFolder(mid.id)).toBeUndefined()
    expect((await getFolder(child.id))?.parentFolderId).toBe(parent.id)
    const inParent = await listWorkflowsInFolder(parent.id)
    expect(inParent.map((w) => w.id)).toContain(wf.id)
  })

  it("reparent mode defaults to lifting content to root", async () => {
    const top = await createFolder({ name: "Top" })
    const wf = await createWorkflow({ name: "WF" })
    await moveWorkflowToFolder(wf.id, top.id)
    await deleteFolder(top.id) // default mode === "reparent"
    const atRoot = await listWorkflowsInFolder(ROOT_FOLDER_ID)
    expect(atRoot.map((w) => w.id)).toContain(wf.id)
  })

  it("cascade mode deletes the subtree and its non-built-in workflows", async () => {
    const a = await createFolder({ name: "A" })
    const b = await createFolder({ name: "B", parentFolderId: a.id })
    const wf = await createWorkflow({ name: "Doomed" })
    await moveWorkflowToFolder(wf.id, b.id)

    await deleteFolder(a.id, "cascade")

    expect(await getFolder(a.id)).toBeUndefined()
    expect(await getFolder(b.id)).toBeUndefined()
    expect(await getDb().workflows.get(wf.id)).toBeUndefined()
  })

  it("cascade mode protects built-in workflows by lifting them to root", async () => {
    const a = await createFolder({ name: "A" })
    const wf = await createWorkflow({ name: "Builtin" })
    await moveWorkflowToFolder(wf.id, a.id)
    await getDb().workflows.update(wf.id, { isBuiltIn: true })

    await deleteFolder(a.id, "cascade")

    const fresh = await getDb().workflows.get(wf.id)
    expect(fresh).toBeDefined()
    expect(fresh?.folderId).toBe(ROOT_FOLDER_ID)
  })

  it("is a no-op on a missing folder", async () => {
    await expect(deleteFolder("wff_missing")).resolves.toBeUndefined()
  })
})

describe("getFolderPath", () => {
  it("returns the chain from topmost ancestor down to the target", async () => {
    const a = await createFolder({ name: "A" })
    const b = await createFolder({ name: "B", parentFolderId: a.id })
    const c = await createFolder({ name: "C", parentFolderId: b.id })
    const path = await getFolderPath(c.id)
    expect(path.map((f) => f.name)).toEqual(["A", "B", "C"])
  })

  it("returns an empty array for the root sentinel and for a missing folder", async () => {
    expect(await getFolderPath(ROOT_FOLDER_ID)).toEqual([])
    expect(await getFolderPath("wff_missing")).toEqual([])
  })
})

describe("getDescendantFolderIds", () => {
  it("collects every folder strictly below the given one", async () => {
    const a = await createFolder({ name: "A" })
    const b = await createFolder({ name: "B", parentFolderId: a.id })
    const c = await createFolder({ name: "C", parentFolderId: b.id })
    const sibling = await createFolder({ name: "Sibling" })
    const ids = await getDescendantFolderIds(a.id)
    expect(ids.has(b.id)).toBe(true)
    expect(ids.has(c.id)).toBe(true)
    expect(ids.has(sibling.id)).toBe(false)
    expect(ids.has(a.id)).toBe(false)
  })
})
