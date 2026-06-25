import "fake-indexeddb/auto"

import { createFolder, deleteFolder, listFolders, renameFolder } from "./session-folders"
import { createSession, getSession, assignSessionToFolder } from "./sessions"
import { saveSettings } from "./settings"
import { getDb, whenSeeded, __resetDbForTesting } from "./schema"

// The /loop cascade tears down backing scheduler tasks via a dynamic import —
// mock the scheduler singleton so no real timing engine spins up.
const schedulerMock = { deleteTask: jest.fn().mockResolvedValue(true) }
jest.mock("@/lib/scheduler/task-scheduler", () => ({
  getTaskScheduler: () => schedulerMock,
}))

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await saveSettings({ activeProjectId: "proj-A" })
})

describe("session-folders CRUD", () => {
  it("creates folders at the end of the workspace list and lists them in order", async () => {
    const a = await createFolder("Work")
    const b = await createFolder("Personal")
    expect(a.order).toBe(0)
    expect(b.order).toBe(1)
    expect(b.projectId).toBe("proj-A")
    const list = await listFolders("proj-A")
    expect(list.map((f) => f.id)).toEqual([a.id, b.id])
  })

  it("scopes folders to their workspace", async () => {
    await createFolder("In A")
    await saveSettings({ activeProjectId: "proj-B" })
    await createFolder("In B")
    expect((await listFolders("proj-A")).map((f) => f.name)).toEqual(["In A"])
    expect((await listFolders("proj-B")).map((f) => f.name)).toEqual(["In B"])
  })

  it("renames a folder", async () => {
    const f = await createFolder("Old")
    await renameFolder(f.id, "  New  ")
    expect((await getDb().sessionFolders.get(f.id))?.name).toBe("New")
  })
})

describe("folder membership", () => {
  it("assigns a session to a folder and back to loose without deleting it", async () => {
    const folder = await createFolder("Bucket")
    const s = await createSession({ title: "member" })
    await assignSessionToFolder(s.id, folder.id)
    expect((await getSession(s.id))?.folderId).toBe(folder.id)
    await assignSessionToFolder(s.id, null)
    const after = await getSession(s.id)
    expect(after).toBeDefined()
    expect("folderId" in (after as object)).toBe(false)
  })

  it("deleting a folder reverts its members to loose and never deletes sessions", async () => {
    const folder = await createFolder("Doomed")
    const inside = await createSession({ title: "inside" })
    const outside = await createSession({ title: "outside" })
    await assignSessionToFolder(inside.id, folder.id)

    await deleteFolder(folder.id)

    expect(await getDb().sessionFolders.get(folder.id)).toBeUndefined()
    // The member survives, now loose.
    const member = await getSession(inside.id)
    expect(member).toBeDefined()
    expect(member?.folderId).toBeUndefined()
    // The unrelated session is untouched.
    expect(await getSession(outside.id)).toBeDefined()
  })
})
