import { liveQuery } from "dexie"

import {
  createFolder,
  deleteFolder,
  listFolders,
  renameFolder,
  reorderFolders,
} from "./session-folders"
import { createSession, getSession, assignSessionToFolder } from "./sessions"
import { saveSettings } from "./settings"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"

// The /loop cascade tears down backing scheduler tasks via a dynamic import —
// mock the scheduler singleton so no real timing engine spins up.
const schedulerMock = { deleteTask: jest.fn().mockResolvedValue(true) }
jest.mock("@/lib/scheduler/task-scheduler", () => ({
  getTaskScheduler: () => schedulerMock,
}))

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await saveSettings({ activeProjectId: "proj-A" })
})
afterAll(dbFixture.dispose)

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

  it("persists a manual folder order", async () => {
    const a = await createFolder("Work")
    const b = await createFolder("Personal")
    const c = await createFolder("Reading")
    await reorderFolders([c.id, a.id, b.id])
    expect((await listFolders("proj-A")).map((f) => f.name)).toEqual([
      "Reading",
      "Work",
      "Personal",
    ])
    expect((await getDb().sessionFolders.get(c.id))?.order).toBe(0)
  })

  it("ignores unknown ids and keeps unnamed folders after the ones given", async () => {
    const a = await createFolder("A")
    await createFolder("B")
    const c = await createFolder("C")
    // `gone` was deleted by another surface between the drag and the drop; the
    // "B" folder simply was not part of the request.
    await reorderFolders([c.id, "gone", a.id])
    expect((await listFolders("proj-A")).map((f) => f.name)).toEqual(["C", "A", "B"])
  })

  it("does not renumber another workspace's folders", async () => {
    const inA = await createFolder("In A")
    await saveSettings({ activeProjectId: "proj-B" })
    const first = await createFolder("B first")
    const second = await createFolder("B second")
    await reorderFolders([second.id, first.id])
    expect((await listFolders("proj-B")).map((f) => f.name)).toEqual(["B second", "B first"])
    expect((await getDb().sessionFolders.get(inA.id))?.order).toBe(0)
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

  // Regression: same liveQuery zone-safety as `listScopedSessions` — with an
  // explicit pid the Dexie read must be registered before any await, or folder
  // mutations never re-emit to the sidebar.
  it("re-emits an explicit-pid liveQuery after a rename", async () => {
    const f = await createFolder("Old")

    const emissions: string[][] = []
    const sub = liveQuery(() => listFolders("proj-A")).subscribe({
      next: (rows) => emissions.push(rows.map((r) => r.name)),
    })
    const waitUntil = async (pred: () => boolean) => {
      const start = Date.now()
      while (!pred()) {
        if (Date.now() - start > 3000) throw new Error("waitUntil timed out")
        await new Promise((r) => setTimeout(r, 20))
      }
    }
    await waitUntil(() => emissions.length >= 1)
    await renameFolder(f.id, "New")
    await waitUntil(() => emissions.length >= 2)
    sub.unsubscribe()

    expect(emissions[emissions.length - 1]).toEqual(["New"])
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
